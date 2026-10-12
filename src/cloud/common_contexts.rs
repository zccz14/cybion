//! The Cybion Common Context: product usage guidance compiled into the binary.
//!
//! INVARIANT: user-readable common content is compiled in from `common-contexts/`;
//! the controller never stores, mutates, or synthesizes it at runtime, so every
//! user reads the same tree for a given build and changes ship with releases.

use super::*;

/// The tree skeleton (`common-contexts/tree.json`); every node's Markdown lives
/// in `common-contexts/<content_file>` and is inlined through `CONTENT`.
#[derive(Deserialize)]
struct CommonTree {
    revision: i64,
    root: CommonNode,
}

#[derive(Deserialize)]
struct CommonNode {
    id: String,
    name: String,
    description: String,
    content_file: String,
    #[serde(default)]
    children: Vec<CommonNode>,
}

static TREE: LazyLock<CommonTree> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../common-contexts/tree.json"))
        .expect("common-contexts/tree.json is valid JSON")
});

/// `content_file` → Markdown body. `include_str!` needs literal paths, so every
/// file is listed here; a test pins the list against the tree.
const CONTENT: &[(&str, &str)] = &[
    (
        "nodes/overview.md",
        include_str!("../../common-contexts/nodes/overview.md"),
    ),
    (
        "nodes/ultimate-machine/overview.md",
        include_str!("../../common-contexts/nodes/ultimate-machine/overview.md"),
    ),
    (
        "nodes/ultimate-machine/when-to-create.md",
        include_str!("../../common-contexts/nodes/ultimate-machine/when-to-create.md"),
    ),
    (
        "nodes/ultimate-machine/writing-checks.md",
        include_str!("../../common-contexts/nodes/ultimate-machine/writing-checks.md"),
    ),
    (
        "nodes/ultimate-machine/management-tools.md",
        include_str!("../../common-contexts/nodes/ultimate-machine/management-tools.md"),
    ),
    (
        "nodes/ultimate-machine/after-failure.md",
        include_str!("../../common-contexts/nodes/ultimate-machine/after-failure.md"),
    ),
    (
        "nodes/ultimate-machine/pitfalls.md",
        include_str!("../../common-contexts/nodes/ultimate-machine/pitfalls.md"),
    ),
];

fn content(path: &str) -> &'static str {
    CONTENT
        .iter()
        .find(|(candidate, _)| *candidate == path)
        .map(|(_, body)| *body)
        .unwrap_or_default()
}

/// The top-level item `cybion_list_contexts` lists before the user's own Contexts.
pub(super) fn root_summary() -> Value {
    json!({
        "context_id": TREE.root.id.as_str(),
        "name": TREE.root.name.as_str(),
        "description": TREE.root.description.as_str(),
        "source": "common",
    })
}

/// Reads one common node with its direct children, mirroring a local Context read.
pub(super) fn read(id: &str) -> Option<ContextReadView> {
    let (node, parent_id) = locate(&TREE.root, None, id)?;
    Some(ContextReadView {
        context: ContextView {
            id: node.id.clone(),
            name: node.name.clone(),
            description: node.description.clone(),
            content: content(&node.content_file).to_owned(),
            parent_id,
        },
        children: node
            .children
            .iter()
            .map(|child| ContextSummary {
                context_id: child.id.clone(),
                name: child.name.clone(),
                description: child.description.clone(),
            })
            .collect(),
    })
}

fn locate<'a>(
    node: &'a CommonNode,
    parent_id: Option<String>,
    id: &str,
) -> Option<(&'a CommonNode, Option<String>)> {
    if node.id == id {
        return Some((node, parent_id));
    }
    node.children
        .iter()
        .find_map(|child| locate(child, Some(node.id.clone()), id))
}

/// The whole tree with inlined content, served to the browser at
/// `GET /api/common-contexts` so users browse exactly what Threads can read.
pub(super) async fn documents(
    axum::Extension(_identity): axum::Extension<BrowserIdentity>,
) -> Json<Value> {
    Json(tree_view())
}

fn tree_view() -> Value {
    json!({ "revision": TREE.revision, "root": node_view(&TREE.root) })
}

fn node_view(node: &CommonNode) -> Value {
    json!({
        "id": node.id.as_str(),
        "name": node.name.as_str(),
        "description": node.description.as_str(),
        "content": content(&node.content_file),
        "children": node.children.iter().map(node_view).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn walk<'a>(node: &'a CommonNode, visit: &mut impl FnMut(&'a CommonNode)) {
        visit(node);
        for child in &node.children {
            walk(child, visit);
        }
    }

    fn nodes() -> Vec<&'static CommonNode> {
        let mut items = Vec::new();
        walk(&TREE.root, &mut |node| items.push(node));
        items
    }

    #[test]
    fn every_node_has_a_unique_uuid_and_compiled_content() {
        let mut ids = std::collections::BTreeSet::new();
        for node in nodes() {
            Uuid::parse_str(&node.id).expect("common context ids are UUIDs");
            assert!(ids.insert(node.id.as_str()), "duplicate id {}", node.id);
            assert!(!node.name.trim().is_empty());
            assert!(!node.description.trim().is_empty());
            let body = content(&node.content_file);
            assert!(
                !body.trim().is_empty(),
                "{} has no compiled content",
                node.content_file
            );
        }
    }

    #[test]
    fn content_list_covers_exactly_the_tree_files() {
        let tree_files: std::collections::BTreeSet<&str> = nodes()
            .iter()
            .map(|node| node.content_file.as_str())
            .collect();
        let listed: std::collections::BTreeSet<&str> =
            CONTENT.iter().map(|(path, _)| *path).collect();
        assert_eq!(tree_files, listed);
    }

    #[test]
    fn read_returns_the_node_with_its_parent_and_children() {
        let root = read(&TREE.root.id).expect("the root reads");
        assert_eq!(root.context.parent_id, None);
        assert_eq!(root.children.len(), TREE.root.children.len());
        let child = read(&TREE.root.children[0].id).expect("a child reads");
        assert_eq!(
            child.context.parent_id.as_deref(),
            Some(TREE.root.id.as_str())
        );
        assert!(!child.context.content.is_empty());
        assert!(read("00000000-0000-4000-8000-000000000000").is_none());
    }

    #[test]
    fn root_summary_is_the_listed_common_entry() {
        let summary = root_summary();
        assert_eq!(summary["source"], "common");
        assert_eq!(summary["name"], "Cybion Common Context");
        assert_eq!(summary["context_id"], TREE.root.id.as_str());
    }
}
