//! Child Threads (子线程) and the pool of money they draw on.
//!
//! A Thread may hand one task to a new child Thread and name the slice of its
//! own USD budget that child may spend. The durable state is one column:
//! `threads.parent_thread_id`. A slice is a number on a row, taking one back is
//! writing a smaller one, and a child that finishes under its slice returns
//! nothing because nothing was ever debited.
//!
//! One rule bounds the whole branch: before a Thread starts another request,
//! every Thread above it that carries a ceiling is compared with what its whole
//! branch has settled. A slice therefore can never outlive the budget that
//! granted it, and the total stays in the root — the Thread a person created,
//! and the only one whose budget falls back to the account default.
//!
//! The gate reads settled cost, so it is a bound one request wide per running
//! Thread: the same honesty the single-Thread budget already had, now shared by
//! a branch instead of one Thread.

use super::*;

use blocked::dollars;

/// Deepest a Thread may sit below a root. Each level is a whole context of its
/// own: it costs a prompt and a person's attention, and three is the deepest
/// branch still readable at a glance. It also keeps both walks — up to the
/// ceilings, down the branch — bounded by a constant.
pub(super) const MAX_DEPTH: i64 = 3;
/// Branches one tree read answers with before it says it truncated.
const MAX_TREE_NODES: usize = 50;
/// Characters of a child's final message a parent may read. That message is the
/// deliverable; anything longer belongs in a file, and the path is short.
const MAX_ANSWER_CHARS: usize = 4000;
const DEFAULT_WAIT_SECONDS: u64 = 60;
const MAX_WAIT_SECONDS: u64 = 300;
const WAIT_TICK: Duration = Duration::from_millis(250);
const DEFAULT_TREE_DEPTH: i64 = 1;
const MAX_TREE_DEPTH: i64 = 3;

/// A settled amount the way every tool here reports it: dollars to the
/// nanodollar, as a number the model can compare without parsing a string.
fn usd(nanos: i64) -> f64 {
    (nanos as f64 / 1_000_000_000.0 * 10_000.0).round() / 10_000.0
}

/// The ceiling one row carries, given where it sits. A root follows the account
/// default when it has no override of its own. Every other Thread reads its own
/// column only: a slice its parent granted must never widen into the
/// account-wide default, because a subcontract whose price nobody named is a
/// bug and inheriting it silently would make the root's total unenforceable.
fn effective_budget(thread: &ThreadView, defaults: &ThreadDefaults) -> i64 {
    match thread.budget_usd_nanos {
        Some(nanos) => nanos,
        None if thread.parent_thread_id.is_none() => defaults.budget_usd_nanos,
        None => 0,
    }
}

/// Settled spend of one Thread and everything below it.
fn subtree_spent(connection: &Connection, thread_id: &str) -> Result<i64, ApiError> {
    Ok(connection.query_row(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM threads WHERE id=?1
           UNION ALL SELECT t.id FROM sub JOIN threads t ON t.parent_thread_id=sub.id
         )
         SELECT COALESCE(SUM(a.cost_usd_nanos),0) FROM reasoning_audits a
          WHERE a.thread_id IN (SELECT id FROM sub)",
        [thread_id],
        |row| row.get(0),
    )?)
}

/// What this Thread has promised to the Threads directly below it. A slice
/// counts from the moment it is granted: an unspent promise is what keeps a
/// second child from being promised the same money.
fn allotted(connection: &Connection, thread_id: &str) -> Result<i64, ApiError> {
    Ok(connection.query_row(
        "SELECT COALESCE(SUM(budget_usd_nanos),0) FROM threads
          WHERE parent_thread_id=? AND budget_usd_nanos>0",
        [thread_id],
        |row| row.get(0),
    )?)
}

/// How deep one Thread sits: 0 for a root.
pub(super) fn depth_of(connection: &Connection, thread_id: &str) -> Result<i64, ApiError> {
    Ok(connection.query_row(
        "WITH RECURSIVE up(id,parent_thread_id,depth) AS (
           SELECT id,parent_thread_id,0 FROM threads WHERE id=?1
           UNION ALL
           SELECT t.id,t.parent_thread_id,up.depth+1 FROM up JOIN threads t ON t.id=up.parent_thread_id
         ) SELECT COALESCE(MAX(depth),0) FROM up",
        [thread_id],
        |row| row.get(0),
    )?)
}

#[derive(Serialize)]
pub(super) struct Pool {
    pub(super) thread_id: String,
    /// The ceiling this Thread carries; `None` when it has none of its own.
    pub(super) budget_usd: Option<f64>,
    /// Settled spend of this Thread and every Thread below it.
    pub(super) subtree_spent_usd: f64,
    /// Promised to the Threads below, spent or not.
    pub(super) allotted_usd: f64,
    /// `budget - spent - allotted`; `None` when the Thread carries no ceiling.
    pub(super) remaining_usd: Option<f64>,
}

fn pool(connection: &Connection, thread_id: &str) -> Result<Pool, ApiError> {
    let thread = load_thread(connection, thread_id)?;
    let ceiling = match effective_budget(&thread, &load_thread_defaults(connection)?) {
        0 => None,
        nanos => Some(nanos),
    };
    let spent = subtree_spent(connection, thread_id)?;
    let promised = allotted(connection, thread_id)?;
    Ok(Pool {
        thread_id: thread_id.to_owned(),
        budget_usd: ceiling.map(usd),
        subtree_spent_usd: usd(spent),
        allotted_usd: usd(promised),
        remaining_usd: ceiling.map(|nanos| usd((nanos - spent - promised).max(0))),
    })
}

/// The ceiling that ran out, and whose it was. A Thread stopped by a slice its
/// parent granted must not read as one whose owner is out of money, and the
/// person reading the record needs to know which Thread to open.
pub(super) struct Exceeded {
    pub thread_id: String,
    pub title: String,
    pub budget_usd_nanos: i64,
    pub spent_usd_nanos: i64,
    /// True when the ceiling is this Thread's own; false when it belongs to a
    /// Thread above it.
    pub own: bool,
}

/// Walks from one Thread up to its root and answers the first ceiling that no
/// longer covers the branch below it.
///
/// The chain is walked rather than only the Thread itself because a slice is
/// spent under its parent's budget too: a child left running after the root is
/// exhausted would spend money nobody has. One statement, one row per level.
pub(super) fn exhausted(
    connection: &Connection,
    thread_id: &str,
    default_budget_usd_nanos: i64,
) -> Result<Option<Exceeded>, ApiError> {
    let mut statement = connection.prepare(
        "WITH RECURSIVE up(id,title,parent_thread_id,budget,depth) AS (
           SELECT id,title,parent_thread_id,
                  CASE WHEN parent_thread_id IS NULL
                       THEN COALESCE(budget_usd_nanos,?2)
                       ELSE COALESCE(budget_usd_nanos,0) END,
                  0
             FROM threads WHERE id=?1
           UNION ALL
           SELECT t.id,t.title,t.parent_thread_id,COALESCE(t.budget_usd_nanos,0),up.depth+1
             FROM up JOIN threads t ON t.id=up.parent_thread_id
         )
         SELECT up.id,up.title,up.depth,up.budget,
                (WITH RECURSIVE down(id) AS (
                   SELECT up.id
                   UNION ALL SELECT t.id FROM down JOIN threads t ON t.parent_thread_id=down.id)
                 SELECT COALESCE(SUM(a.cost_usd_nanos),0) FROM reasoning_audits a
                  WHERE a.thread_id IN (SELECT id FROM down)) AS spent
           FROM up ORDER BY up.depth",
    )?;
    let rows = statement.query_map(params![thread_id, default_budget_usd_nanos], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    for row in rows {
        let (id, title, depth, budget, spent) = row?;
        if budget > 0 && spent >= budget {
            return Ok(Some(Exceeded {
                thread_id: id,
                title,
                budget_usd_nanos: budget,
                spent_usd_nanos: spent,
                own: depth == 0,
            }));
        }
    }
    Ok(None)
}

/// Refuses a child the branch cannot afford, or one that would hang too deep.
/// Runs inside the transaction that inserts the child, so two children created
/// at the same moment cannot both be promised money only one of them fits.
pub(super) fn check_child(
    connection: &Connection,
    parent: &ThreadView,
    child_budget_usd_nanos: Option<i64>,
    defaults: &ThreadDefaults,
) -> Result<(), ApiError> {
    let depth = depth_of(connection, &parent.id)? + 1;
    if depth >= MAX_DEPTH {
        return Err(ApiError::conflict(format!(
            "a Thread may not create another one {MAX_DEPTH} levels deep"
        )));
    }
    let ceiling = effective_budget(parent, defaults);
    let slice = child_budget_usd_nanos.unwrap_or(0);
    if ceiling > 0 && slice > 0 {
        let spent = subtree_spent(connection, &parent.id)?;
        let promised = allotted(connection, &parent.id)?;
        if spent + promised + slice > ceiling {
            return Err(ApiError::conflict(format!(
                "this Thread can offer {} more: {} is settled, {} is already promised, \
                 and its own ceiling is {}",
                dollars(ceiling.saturating_sub(spent + promised)),
                dollars(spent),
                dollars(promised),
                dollars(ceiling),
            )));
        }
    }
    Ok(())
}

/// True when `target` sits below `caller`. A Thread steers only its own branch:
/// one that could steer its parent would let a subcontracted Thread rewrite the
/// plan that sent it.
pub(super) fn is_below(
    connection: &Connection,
    caller: &str,
    target: &str,
) -> Result<bool, ApiError> {
    Ok(connection.query_row(
        "WITH RECURSIVE up(id,parent_thread_id) AS (
           SELECT id,parent_thread_id FROM threads WHERE id=?1
           UNION ALL
           SELECT t.id,t.parent_thread_id FROM up JOIN threads t ON t.id=up.parent_thread_id
         ) SELECT EXISTS(SELECT 1 FROM up WHERE id=?2)",
        params![target, caller],
        |row| row.get(0),
    )?)
}

/// Refuses a target this Thread does not own. Everything a Thread may do to a
/// child passes through here, so the rule is written once.
pub(super) fn require_below(
    connection: &Connection,
    caller: &str,
    target: &str,
) -> Result<(), ApiError> {
    is_below(connection, caller, target)?
        .then_some(())
        .ok_or_else(|| ApiError::not_found("no Thread below this one with that id"))
}

#[derive(Serialize)]
pub(super) struct TreeNode {
    pub(super) thread_id: String,
    pub(super) title: String,
    /// 1 for a direct child, more for a grandchild.
    pub(super) depth: i64,
    pub(super) status: String,
    /// Waiting on the Thread above it, which is the one that has to answer.
    pub(super) blocked: bool,
    pub(super) budget_usd: Option<f64>,
    pub(super) subtree_spent_usd: f64,
    pub(super) children: i64,
    updated_at: i64,
}

#[derive(Serialize)]
pub(super) struct TreeView {
    /// The Thread the listing was asked from: what it may still grant.
    pub(super) pool: Pool,
    /// Flat and depth-ordered: a tree shape would cost the reader more than the
    /// depth column already tells it.
    pub(super) nodes: Vec<TreeNode>,
    pub(super) truncated: bool,
}

/// One read model behind both `list_thread_tree` and the branch view in the web
/// console, so the model and the person never read two different numbers.
pub(super) fn tree(
    connection: &Connection,
    root_id: &str,
    depth: i64,
) -> Result<TreeView, ApiError> {
    load_thread(connection, root_id)?;
    let mut statement = connection.prepare(
        "WITH RECURSIVE down(id,depth) AS (
           SELECT id,0 FROM threads WHERE id=?1
           UNION ALL
           SELECT t.id,down.depth+1 FROM down JOIN threads t ON t.parent_thread_id=down.id
            WHERE down.depth < ?2
         )
         SELECT t.id,t.title,down.depth,t.status,t.blocked,t.budget_usd_nanos,t.updated_at
           FROM down JOIN threads t ON t.id=down.id
          WHERE down.depth > 0
          ORDER BY down.depth,t.updated_at DESC,t.id",
    )?;
    let rows = statement.query_map(params![root_id, depth], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)? != 0,
            row.get::<_, Option<i64>>(5)?,
            row.get::<_, i64>(6)?,
        ))
    })?;
    let mut branches: Vec<(String, String, i64, String, bool, Option<i64>, i64)> = Vec::new();
    let mut truncated = false;
    for row in rows {
        if branches.len() == MAX_TREE_NODES {
            truncated = true;
            break;
        }
        branches.push(row?);
    }
    // One aggregate for the whole branch, folded up in memory: a per-node query
    // would be one audit scan per row, and a person opening a branch with ten
    // children would pay for ten.
    let own = branch_spend(connection, root_id)?;
    let children = child_counts(connection, root_id)?;
    let mut subtree: HashMap<String, i64> = own
        .iter()
        .map(|(id, (_, nanos))| (id.clone(), *nanos))
        .collect();
    for (id, (_, nanos)) in own.iter() {
        let mut cursor = own.get(id).and_then(|(parent, _)| parent.clone());
        for _ in 0..=MAX_DEPTH {
            let Some(ancestor) = cursor else { break };
            let Some(total) = subtree.get_mut(&ancestor) else {
                break;
            };
            *total += nanos;
            cursor = own.get(&ancestor).and_then(|(parent, _)| parent.clone());
        }
    }
    let nodes = branches
        .into_iter()
        .map(
            |(id, title, depth, status, blocked, budget, updated_at)| TreeNode {
                subtree_spent_usd: usd(subtree.get(&id).copied().unwrap_or(0)),
                children: children.get(&id).copied().unwrap_or(0),
                thread_id: id,
                title,
                depth,
                status,
                blocked,
                budget_usd: budget.filter(|nanos| *nanos > 0).map(usd),
                updated_at,
            },
        )
        .collect();
    Ok(TreeView {
        pool: pool(connection, root_id)?,
        nodes,
        truncated,
    })
}

/// Own settled spend and parent, per Thread, for one branch.
fn branch_spend(
    connection: &Connection,
    root_id: &str,
) -> Result<HashMap<String, (Option<String>, i64)>, ApiError> {
    let mut statement = connection.prepare(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM threads WHERE id=?1
           UNION ALL SELECT t.id FROM sub JOIN threads t ON t.parent_thread_id=sub.id
         )
         SELECT s.id,t.parent_thread_id,COALESCE(SUM(a.cost_usd_nanos),0)
           FROM sub s JOIN threads t ON t.id=s.id
           LEFT JOIN reasoning_audits a ON a.thread_id=s.id
          GROUP BY s.id,t.parent_thread_id",
    )?;
    let rows = statement.query_map([root_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut spend = HashMap::new();
    for row in rows {
        let (id, parent, nanos) = row?;
        spend.insert(id, (parent, nanos));
    }
    Ok(spend)
}

fn child_counts(connection: &Connection, root_id: &str) -> Result<HashMap<String, i64>, ApiError> {
    let mut statement = connection.prepare(
        "WITH RECURSIVE sub(id) AS (
           SELECT id FROM threads WHERE id=?1
           UNION ALL SELECT t.id FROM sub JOIN threads t ON t.parent_thread_id=sub.id
         )
         SELECT parent_thread_id,COUNT(*) FROM threads
          WHERE parent_thread_id IN (SELECT id FROM sub) GROUP BY parent_thread_id",
    )?;
    let rows = statement.query_map([root_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut counts = HashMap::new();
    for row in rows {
        let (id, count) = row?;
        counts.insert(id, count);
    }
    Ok(counts)
}

/// The last thing a Thread said, which is what it was asked to deliver.
fn answer(connection: &Connection, thread_id: &str) -> Result<(String, bool), ApiError> {
    let text = load_thread_response(connection, thread_id)?
        .and_then(|stored| serde_json::to_value(&stored.response).ok())
        .and_then(|value| response_text(&value))
        .unwrap_or_default();
    if text.chars().count() > MAX_ANSWER_CHARS {
        let mut clipped = text.chars().take(MAX_ANSWER_CHARS).collect::<String>();
        clipped.push('…');
        return Ok((clipped, true));
    }
    Ok((text, false))
}

/// One Thread as the tools report it: the live row, not the list projection.
fn state_of(connection: &Connection, thread_id: &str) -> Result<(String, bool, i64), ApiError> {
    connection
        .query_row(
            "SELECT status,blocked,updated_at FROM threads WHERE id=?",
            [thread_id],
            |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| ApiError::not_found("thread not found"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateThreadArguments {
    task: String,
    #[serde(default)]
    title: Option<String>,
    /// Dollars. Omitted leaves the child without a ceiling of its own.
    #[serde(default)]
    budget_usd: Option<f64>,
    #[serde(default)]
    settings: Option<ChildSettings>,
}

/// The Thread settings a parent may name for its child. Everything omitted
/// follows the account default, exactly as it does for a Thread a person
/// starts: the parent's own settings are never copied, because a child is a
/// different job and inheriting a model or a Manual list by accident is how a
/// subcontract quietly becomes a different task.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChildSettings {
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    upstream_id: Option<String>,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    initial_manual_ids: Option<Vec<String>>,
    #[serde(default)]
    max_loaded_manuals: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListThreadTreeArguments {
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    depth: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitThreadArguments {
    thread_id: String,
    #[serde(default)]
    timeout_seconds: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlThreadArguments {
    thread_id: String,
    action: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    budget_usd: Option<f64>,
}

/// Dollars from a tool call, in nanodollars. The tool surface speaks dollars
/// because a model writing `2000000000` is a mistake waiting to happen and the
/// conversion belongs in exactly one place.
fn slice_usd_nanos(value: f64) -> Result<i64, ApiError> {
    if !value.is_finite() || value < 0.0 {
        return Err(ApiError::bad_request(
            "budget_usd must be a positive amount of dollars",
        ));
    }
    let nanos = (value * 1_000_000_000.0).round();
    if nanos > MAX_BUDGET_USD_NANOS as f64 {
        return Err(ApiError::bad_request(
            "budget_usd must be at most 10000 dollars",
        ));
    }
    Ok(nanos as i64)
}

/// Starts a child's first turn on its own task.
///
/// Kept as a plain function on purpose: the request path calls the tool that
/// calls this, so a `tokio::spawn` written inline would ask the compiler to
/// prove `Send` for two futures that each depend on the other. Written here,
/// the proof is made once and the tool only hands work over.
fn start(state: AppState, user: User, thread_id: String, input: Value) {
    tokio::spawn(async move {
        if let Err(error) = enqueue_request(state, user, thread_id, input).await {
            tracing::warn!(error = %error.message, "child Thread did not start");
        }
    });
}

pub(super) async fn create_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let arguments: CreateThreadArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!("create_thread arguments are invalid: {error}"))
    })?;
    let settings = arguments.settings.unwrap_or(ChildSettings {
        model: None,
        upstream_id: None,
        reasoning_effort: None,
        initial_manual_ids: None,
        max_loaded_manuals: None,
    });
    // A model name without the upstream that serves it would silently land on
    // the account default upstream, which may not carry that model at all, so
    // the pair travels together or not at all.
    if settings.model.is_some() != settings.upstream_id.is_some() {
        return Err(ApiError::bad_request(
            "settings.model and settings.upstream_id must be given together",
        ));
    }
    let budget_usd_nanos = arguments.budget_usd.map(slice_usd_nanos).transpose()?;
    let task = input_message(arguments.task, Vec::new(), Vec::new())?;
    let child = create_thread_for(
        state,
        user,
        CreateThreadInput {
            title: arguments.title,
            external_ref: None,
            model: settings.model,
            upstream_id: settings.upstream_id,
            reasoning_effort: settings.reasoning_effort,
            service_tier_fast: None,
            initial_manual_ids: settings.initial_manual_ids,
            context_budget_tokens: None,
            minimal_mode: None,
            image_generation_model: None,
            max_loaded_manuals: settings.max_loaded_manuals,
            audio_transcription_model: None,
            budget_usd_nanos,
        },
        ThreadOrigin::Child {
            parent_thread_id: thread_id.to_owned(),
        },
    )
    .await?;
    let child_id = child.id.clone();
    start(state.clone(), user.clone(), child_id.clone(), task);
    let parent = thread_id.to_owned();
    let pool = user_db(state, user, false, move |connection| {
        pool(connection, &parent)
    })
    .await?;
    Ok(json!({
        "thread_id": child_id,
        "title": child.title,
        "model": child.model,
        "budget_usd": budget_usd_nanos.map(usd),
        "started": true,
        // The pool comes back with every grant, so a parent never has to do the
        // arithmetic itself or spend a read to learn what it has left.
        "parent": pool,
    }))
}

pub(super) async fn list_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let caller = thread_id.to_owned();
    let arguments: ListThreadTreeArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!("list_thread_tree arguments are invalid: {error}"))
    })?;
    let depth = arguments.depth.unwrap_or(DEFAULT_TREE_DEPTH);
    if !(1..=MAX_TREE_DEPTH).contains(&depth) {
        return Err(ApiError::bad_request(format!(
            "depth must be between 1 and {MAX_TREE_DEPTH}"
        )));
    }
    let root = match arguments.thread_id {
        Some(id) => super::thread_id(&id)?,
        None => caller.clone(),
    };
    let tree = user_db(state, user, false, move |connection| {
        if root != caller {
            require_below(connection, &caller, &root)?;
        }
        tree(connection, &root, depth)
    })
    .await?;
    Ok(serde_json::to_value(tree).map_err(ApiError::internal)?)
}

pub(super) async fn wait_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let caller = thread_id.to_owned();
    let arguments: WaitThreadArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!("wait_for_thread arguments are invalid: {error}"))
    })?;
    let target = super::thread_id(&arguments.thread_id)?;
    let seconds = arguments
        .timeout_seconds
        .unwrap_or(DEFAULT_WAIT_SECONDS)
        .clamp(1, MAX_WAIT_SECONDS);
    user_db(state, user, false, {
        let target = target.clone();
        move |connection| require_below(connection, &caller, &target)
    })
    .await?;
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    loop {
        let id = target.clone();
        let (status, blocked, _) = user_db(state, user, false, move |connection| {
            state_of(connection, &id)
        })
        .await?;
        let settled = status != "running";
        if settled || std::time::Instant::now() >= deadline {
            let id = target.clone();
            let (answer, clipped) = user_db(state, user, false, move |connection| {
                answer(connection, &id)
            })
            .await?;
            let id = target.clone();
            let spend =
                user_db(state, user, false, move |connection| pool(connection, &id)).await?;
            return Ok(json!({
                "thread_id": target,
                "settled": settled,
                "status": status,
                "blocked": blocked,
                "spent_usd": spend.subtree_spent_usd,
                "answer": answer,
                "answer_truncated": clipped,
            }));
        }
        tokio::time::sleep(WAIT_TICK).await;
    }
}

pub(super) async fn control_tool_output(
    state: &AppState,
    user: &User,
    thread_id: &str,
    input: &str,
) -> Result<Value, ApiError> {
    let caller = thread_id.to_owned();
    let arguments: ControlThreadArguments = serde_json::from_str(input).map_err(|error| {
        ApiError::bad_request(format!("control_thread arguments are invalid: {error}"))
    })?;
    let target = super::thread_id(&arguments.thread_id)?;
    user_db(state, user, false, {
        let target = target.clone();
        move |connection| require_below(connection, &caller, &target)
    })
    .await?;
    match arguments.action.as_str() {
        "message" => {
            let text = arguments
                .text
                .ok_or_else(|| ApiError::bad_request("message needs text"))?;
            // An input record is what a person speaking writes, and it is what
            // clears a block: the parent is the other principal a blocked child
            // may be waiting on. The turn is started on its own task for the same
            // reason `create_thread` does it that way.
            start(
                state.clone(),
                user.clone(),
                target.clone(),
                input_message(text, Vec::new(), Vec::new())?,
            );
        }
        "top_up" => {
            let nanos = slice_usd_nanos(
                arguments
                    .budget_usd
                    .ok_or_else(|| ApiError::bad_request("top_up needs budget_usd"))?,
            )?;
            let id = target.clone();
            user_db(state, user, true, move |connection| {
                allot(connection, &id, Some(nanos))
            })
            .await?;
        }
        "stop" => {
            thread_controls::cancel_for(state, user, target.clone()).await?;
        }
        other => {
            return Err(ApiError::bad_request(format!(
                "action must be message, top_up or stop, not {other}"
            )));
        }
    }
    let id = target.clone();
    let (status, blocked, _) = user_db(state, user, false, move |connection| {
        state_of(connection, &id)
    })
    .await?;
    let id = target.clone();
    let child = user_db(state, user, false, move |connection| pool(connection, &id)).await?;
    let caller = thread_id.to_owned();
    let parent = user_db(state, user, false, move |connection| {
        pool(connection, &caller)
    })
    .await?;
    Ok(json!({
        "thread_id": target,
        "status": status,
        "blocked": blocked,
        "budget_usd": child.budget_usd,
        "subtree_spent_usd": child.subtree_spent_usd,
        "parent": parent,
    }))
}

/// Rewrites one child's slice, within what its parent has left. The old slice
/// comes back into the parent's pool first, so raising and lowering both speak
/// the same language: a slice is a promise the parent may re-cut.
fn allot(
    connection: &mut Connection,
    child_id: &str,
    budget_usd_nanos: Option<i64>,
) -> Result<(), ApiError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let child = load_thread(&transaction, child_id)?;
    let parent_id = child
        .parent_thread_id
        .clone()
        .ok_or_else(|| ApiError::bad_request("a root Thread has no slice to change"))?;
    let parent = load_thread(&transaction, &parent_id)?;
    let defaults = load_thread_defaults(&transaction)?;
    let ceiling = effective_budget(&parent, &defaults);
    let slice = budget_usd_nanos.unwrap_or(0);
    if ceiling > 0 && slice > 0 {
        let spent = subtree_spent(&transaction, &parent_id)?;
        let promised =
            allotted(&transaction, &parent_id)? - child.budget_usd_nanos.unwrap_or(0).max(0);
        if spent + promised + slice > ceiling {
            return Err(ApiError::conflict(format!(
                "this Thread can offer {} more: {} is settled, {} is promised to its other children, \
                 and its own ceiling is {}",
                dollars(ceiling.saturating_sub(spent + promised)),
                dollars(spent),
                dollars(promised),
                dollars(ceiling),
            )));
        }
    }
    transaction.execute(
        "UPDATE threads SET budget_usd_nanos=?,updated_at=? WHERE id=?",
        params![budget_usd_nanos, now(), child_id],
    )?;
    // A larger slice is an answer to a child stopped on its ceiling, so it also
    // lifts the block — the parent is a principal, never a kernel event.
    if budget_usd_nanos.is_some_and(|nanos| nanos > child.usage.cost_usd_nanos) {
        blocked::clear_on_parent_action(&transaction, child_id)?;
    }
    transaction.commit()?;
    Ok(())
}
