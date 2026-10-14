//! The Cybion Common Context: product usage guidance compiled into the binary.
//!
//! INVARIANT: user-readable common content is compiled in from `common-contexts/`
//! as bilingual (en/zh) copy; the controller never stores, mutates, or
//! synthesizes it at runtime, so every user reads the same tree for a given
//! build and changes ship with releases. Reads select a language: the browser
//! passes its UI language, while model-side tools read the source language.

use super::*;

/// The compiled source language. It backs the model-side reads and any read
/// that carries no explicit language.
pub(super) const SOURCE_LANGUAGE: &str = "zh";

/// `?lang=` on the browser reads: `en` selects the English copy, anything else
/// (including no value) falls back to the source language.
#[derive(Deserialize)]
pub(super) struct LanguageQuery {
    pub(super) lang: Option<String>,
}

pub(super) fn parse_language(value: Option<&str>) -> &'static str {
    match value {
        Some(value) if value.eq_ignore_ascii_case("en") => "en",
        _ => SOURCE_LANGUAGE,
    }
}

/// Bilingual copy: a node carries the same information in every language.
#[derive(Deserialize)]
struct Localized {
    en: String,
    zh: String,
}

impl Localized {
    fn get(&self, language: &str) -> &str {
        if language == "en" { &self.en } else { &self.zh }
    }
}

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
    name: Localized,
    description: Localized,
    content_file: Localized,
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
        "nodes/en/overview.md",
        include_str!("../../common-contexts/nodes/en/overview.md"),
    ),
    (
        "nodes/en/ultimate-machine.md",
        include_str!("../../common-contexts/nodes/en/ultimate-machine.md"),
    ),
    (
        "nodes/en/linkit.md",
        include_str!("../../common-contexts/nodes/en/linkit.md"),
    ),
    (
        "nodes/zh/overview.md",
        include_str!("../../common-contexts/nodes/zh/overview.md"),
    ),
    (
        "nodes/zh/ultimate-machine.md",
        include_str!("../../common-contexts/nodes/zh/ultimate-machine.md"),
    ),
    (
        "nodes/zh/linkit.md",
        include_str!("../../common-contexts/nodes/zh/linkit.md"),
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
pub(super) fn root_summary(language: &str) -> Value {
    json!({
        "context_id": TREE.root.id.as_str(),
        "name": TREE.root.name.get(language),
        "description": TREE.root.description.get(language),
        "source": "common",
    })
}

/// Reads one common node with its direct children, mirroring a local Context read.
pub(super) fn read(id: &str, language: &str) -> Option<ContextReadView> {
    let (node, parent_id) = locate(&TREE.root, None, id)?;
    Some(ContextReadView {
        context: ContextView {
            id: node.id.clone(),
            name: node.name.get(language).to_owned(),
            description: node.description.get(language).to_owned(),
            content: content(node.content_file.get(language)).to_owned(),
            parent_id,
            sort_key: String::new(),
            trashed_at: None,
        },
        children: node
            .children
            .iter()
            .map(|child| ContextSummary {
                context_id: child.id.clone(),
                name: child.name.get(language).to_owned(),
                description: child.description.get(language).to_owned(),
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
/// `GET /api/common-contexts?lang=` so users browse exactly what Threads can
/// read, in the language the UI shows.
pub(super) async fn documents(
    axum::Extension(_identity): axum::Extension<BrowserIdentity>,
    axum::extract::Query(query): axum::extract::Query<LanguageQuery>,
) -> Json<Value> {
    Json(tree_view(parse_language(query.lang.as_deref())))
}

fn tree_view(language: &str) -> Value {
    json!({ "revision": TREE.revision, "root": node_view(&TREE.root, language) })
}

fn node_view(node: &CommonNode, language: &str) -> Value {
    json!({
        "id": node.id.as_str(),
        "name": node.name.get(language),
        "description": node.description.get(language),
        "content": content(node.content_file.get(language)),
        "children": node
            .children
            .iter()
            .map(|child| node_view(child, language))
            .collect::<Vec<_>>(),
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
    fn every_node_has_a_unique_uuid_and_bilingual_copy() {
        let mut ids = std::collections::BTreeSet::new();
        for node in nodes() {
            Uuid::parse_str(&node.id).expect("common context ids are UUIDs");
            assert!(ids.insert(node.id.as_str()), "duplicate id {}", node.id);
            for language in ["en", "zh"] {
                assert!(!node.name.get(language).trim().is_empty());
                assert!(!node.description.get(language).trim().is_empty());
                let body = content(node.content_file.get(language));
                assert!(
                    !body.trim().is_empty(),
                    "{} has no compiled {language} content",
                    node.content_file.get(language)
                );
            }
        }
    }

    #[test]
    fn content_list_covers_exactly_the_tree_files() {
        let tree_files: std::collections::BTreeSet<&str> = nodes()
            .iter()
            .flat_map(|node| [node.content_file.en.as_str(), node.content_file.zh.as_str()])
            .collect();
        let listed: std::collections::BTreeSet<&str> =
            CONTENT.iter().map(|(path, _)| *path).collect();
        assert_eq!(tree_files, listed);
    }

    #[test]
    fn read_returns_the_node_with_its_parent_and_children() {
        let root = read(&TREE.root.id, "zh").expect("the root reads");
        assert_eq!(root.context.parent_id, None);
        assert_eq!(root.context.name, "Cybion 公共上下文");
        assert_eq!(root.children.len(), TREE.root.children.len());
        let child = read(&TREE.root.children[0].id, "en").expect("a child reads");
        assert_eq!(
            child.context.parent_id.as_deref(),
            Some(TREE.root.id.as_str())
        );
        assert_eq!(child.context.name, "Ultimate Machine");
        assert!(!child.context.content.is_empty());
        assert!(read("00000000-0000-4000-8000-000000000000", "zh").is_none());
    }

    #[test]
    fn parse_language_falls_back_to_the_source_language() {
        assert_eq!(parse_language(None), "zh");
        assert_eq!(parse_language(Some("en")), "en");
        assert_eq!(parse_language(Some("EN")), "en");
        assert_eq!(parse_language(Some("zh-CN")), "zh");
        assert_eq!(parse_language(Some("fr")), "zh");
    }

    #[test]
    fn root_summary_is_the_listed_common_entry() {
        let summary = root_summary("zh");
        assert_eq!(summary["source"], "common");
        assert_eq!(summary["name"], "Cybion 公共上下文");
        assert_eq!(summary["context_id"], TREE.root.id.as_str());
        assert_eq!(root_summary("en")["name"], "Cybion Common Context");
    }

    #[test]
    fn tree_view_serves_each_language_with_its_own_copy() {
        let zh = tree_view("zh");
        let en = tree_view("en");
        assert_eq!(zh["root"]["name"], "Cybion 公共上下文");
        assert_eq!(en["root"]["name"], "Cybion Common Context");
        assert!(zh["root"]["content"].as_str().unwrap().contains("操作指南"));
        assert!(
            en["root"]["content"]
                .as_str()
                .unwrap()
                .contains("operating guide")
        );
    }
}
