//! Which party owns a running Thread's progress right now.
//!
//! Every running Thread waits on exactly one of three parties: the upstream
//! inference API (`Inference`), the user's device (`Device`), or this
//! Controller (`Kernel`). The phase is process observation state, not an
//! algorithm input: it rides on the entry `active_requests` already keeps for
//! a live run, and every write is fenced by that entry's request record id, so
//! a superseded task can never repaint a newer request.

use super::*;
use std::future::Future;
use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    Kernel,
    Inference,
    Device,
}

impl Phase {
    fn code(self) -> u8 {
        match self {
            Phase::Kernel => 0,
            Phase::Inference => 1,
            Phase::Device => 2,
        }
    }

    fn from_code(code: u8) -> Phase {
        match code {
            1 => Phase::Inference,
            2 => Phase::Device,
            _ => Phase::Kernel,
        }
    }
}

pub(super) struct PhaseCell {
    code: AtomicU8,
    since: AtomicI64,
}

impl PhaseCell {
    pub(super) fn new() -> Self {
        Self {
            code: AtomicU8::new(Phase::Kernel.code()),
            since: AtomicI64::new(now()),
        }
    }

    fn read(&self) -> (Phase, i64) {
        (
            Phase::from_code(self.code.load(Ordering::Relaxed)),
            self.since.load(Ordering::Relaxed),
        )
    }

    fn set(&self, phase: Phase) {
        if self.code.load(Ordering::Relaxed) != phase.code() {
            self.code.store(phase.code(), Ordering::Relaxed);
            self.since.store(now(), Ordering::Relaxed);
        }
    }

    fn write(&self, (phase, since): (Phase, i64)) {
        self.code.store(phase.code(), Ordering::Relaxed);
        self.since.store(since, Ordering::Relaxed);
    }
}

// INVARIANT: tools.json groups tools by the party that executes them, which is
// exactly the phase taxonomy. `worker` runs on the user's device; `context`
// and `native` run here in the Controller, because start_response_tool
// intercepts the native tools and never asks the upstream to execute them.
// A native tool executed server-side by the upstream would have to move to
// Inference.
pub(super) fn tool_phase(name: &str) -> Option<Phase> {
    let group_has = |group: &str| {
        TOOL_CATALOG[group]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|tool| tool["name"] == name))
    };
    if group_has("worker") {
        return Some(Phase::Device);
    }
    if group_has("context") || TOOL_CATALOG["native"].get(name).is_some() {
        return Some(Phase::Kernel);
    }
    None
}

impl AppState {
    /// Reports the phase of the live run for this Thread. A write only lands
    /// when the registered request record still matches, so a superseded task
    /// cannot repaint a newer request.
    pub(super) async fn set_phase(&self, user: &User, thread: &str, record: i64, phase: Phase) {
        let active = self.active_requests.lock().await;
        if let Some(entry) = active
            .get(&request_key(user, thread))
            .filter(|entry| entry.record_idx == record)
        {
            entry.phase.set(phase);
        }
    }

    /// Runs one Controller-executed tool while the Thread reports Kernel, then
    /// puts the previous phase and its start time back.
    pub(super) async fn kernel_tool<T>(
        &self,
        user: &User,
        thread: &str,
        record: i64,
        tool: impl Future<Output = T>,
    ) -> T {
        let previous = self.swap_phase(user, thread, record, Phase::Kernel).await;
        let output = tool.await;
        if let Some(previous) = previous {
            let active = self.active_requests.lock().await;
            if let Some(entry) = active
                .get(&request_key(user, thread))
                .filter(|entry| entry.record_idx == record)
            {
                entry.phase.write(previous);
            }
        }
        output
    }

    async fn swap_phase(
        &self,
        user: &User,
        thread: &str,
        record: i64,
        phase: Phase,
    ) -> Option<(Phase, i64)> {
        let active = self.active_requests.lock().await;
        let entry = active
            .get(&request_key(user, thread))
            .filter(|entry| entry.record_idx == record)?;
        let previous = entry.phase.read();
        entry.phase.set(phase);
        Some(previous)
    }

    /// Every live run's phase, keyed by (user, Thread).
    pub(super) async fn live_phases(&self) -> HashMap<(String, String), (Phase, i64)> {
        // INVARIANT: request keys are `{user_id}:{thread_id}`, and user_id()
        // rejects ':' while Thread ids are UUIDs.
        self.active_requests
            .lock()
            .await
            .iter()
            .filter_map(|(key, entry)| {
                let (user, thread) = key.split_once(':')?;
                Some(((user.to_owned(), thread.to_owned()), entry.phase.read()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_tools() -> Vec<(&'static str, &'static str)> {
        let mut tools = Vec::new();
        for group in ["context", "worker"] {
            for tool in TOOL_CATALOG[group].as_array().unwrap() {
                tools.push((group, tool["name"].as_str().unwrap()));
            }
        }
        for name in TOOL_CATALOG["native"].as_object().unwrap().keys() {
            tools.push(("native", name.as_str()));
        }
        tools
    }

    #[test]
    fn every_catalog_tool_belongs_to_exactly_one_phase() {
        for (group, name) in catalog_tools() {
            let expected = match group {
                "worker" => Phase::Device,
                _ => Phase::Kernel,
            };
            assert_eq!(tool_phase(name), Some(expected), "{group}/{name}");
        }
        assert_eq!(tool_phase("not_a_tool"), None);
    }

    #[test]
    fn phase_cell_keeps_the_start_time_until_the_phase_changes() {
        let cell = PhaseCell::new();
        let (phase, since) = cell.read();
        assert_eq!(phase, Phase::Kernel);
        cell.set(Phase::Kernel);
        assert_eq!(cell.read(), (Phase::Kernel, since));
        cell.set(Phase::Inference);
        let (phase, moved) = cell.read();
        assert_eq!(phase, Phase::Inference);
        assert!(moved >= since);
        let previous = cell.read();
        cell.write((Phase::Kernel, since));
        assert_eq!(cell.read(), (Phase::Kernel, since));
        cell.write(previous);
        assert_eq!(cell.read(), previous);
    }
}
