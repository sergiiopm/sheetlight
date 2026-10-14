//! Batch undo/redo on top of IronCalc's per-call history.
//!
//! IronCalc pushes one diff list per `UserModel` call. A Sheetlight batch
//! (`apply(ops)`) may make many calls, so each undo step records how many
//! IronCalc entries it produced (`iron`) and undo/redo replays that many with
//! evaluation paused, followed by a single recalculation. Every IronCalc call
//! goes through `WorkbookBackend::ic`, which flushes IronCalc's send queue
//! (otherwise it grows forever) and counts a step when something was queued.
//! Sheetlight's own metadata (comments, autofilter, charts) is restored from
//! snapshots taken before/after the batch.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use ironcalc_base::UserModel;

use super::{ic_error, Meta, WorkbookBackend};
use crate::engine::backend::ApplyOutcome;
use crate::engine::types::*;

/// What a batch touched; used to emit events after apply/undo/redo.
#[derive(Debug, Clone, Default)]
pub(crate) struct Scope {
    pub data: BTreeSet<SheetId>,
    pub cells: BTreeMap<SheetId, Vec<CellRange>>,
    pub info: BTreeSet<SheetId>,
    pub structure: Vec<(SheetId, Axis, StructureOp, u32, u32)>,
    pub sheets: bool,
    pub charts: BTreeSet<SheetId>,
}

/// Mutable state of the batch being applied.
#[derive(Debug, Default)]
pub(crate) struct Batch {
    pub iron: u32,
    pub scope: Scope,
    pub selection: Option<SelectionHint>,
    pub created: Vec<u32>,
    pub affected: u64,
    /// Values may have changed: recalculate at the end.
    pub recalc: bool,
    /// Sheet that should be active at the end of the batch.
    pub active: Option<SheetId>,
}

impl Batch {
    pub fn cells(&mut self, sheet: SheetId, range: CellRange) {
        self.scope.cells.entry(sheet).or_default().push(range);
        self.recalc = true;
    }

    pub fn data(&mut self, sheet: SheetId) {
        self.scope.data.insert(sheet);
        self.recalc = true;
    }

    pub fn style(&mut self, sheet: SheetId, range: CellRange) {
        self.scope.cells.entry(sheet).or_default().push(range);
    }

    pub fn select(&mut self, sheet: SheetId, ranges: Vec<CellRange>) {
        if let Some(first) = ranges.first() {
            let active = CellAddress { row: first.r0, col: first.c0 };
            self.selection = Some(SelectionHint { sheet, ranges, active });
        }
    }
}

#[derive(Debug)]
pub(crate) struct Step {
    iron: u32,
    meta_before: Meta,
    meta_after: Meta,
    selection: Option<SelectionHint>,
    scope: Scope,
    recalc: bool,
    active_before: SheetId,
    active_after: SheetId,
}

#[derive(Debug, Default)]
pub(crate) struct History {
    undo: Vec<Step>,
    redo: Vec<Step>,
}

impl History {
    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }
}

/// Undo history depth kept (oldest steps are dropped beyond this).
const MAX_STEPS: usize = 500;

impl WorkbookBackend {
    /// Runs one IronCalc mutation and counts the undo entry it produced.
    pub(crate) fn ic<T>(
        &mut self,
        batch: &mut Batch,
        f: impl FnOnce(&mut UserModel<'static>) -> Result<T, String>,
    ) -> EngineResult<T> {
        let result = f(&mut self.um);
        if self.um.flush_send_queue().len() > self.empty_queue_len {
            batch.iron += 1;
        }
        result.map_err(ic_error)
    }

    pub(crate) fn apply_batch(&mut self, ops: &[EngineOp]) -> EngineResult<ApplyOutcome> {
        let started = Instant::now();
        let _ = self.um.flush_send_queue();
        let meta_before = self.meta.clone();
        let active_before = <Self as crate::engine::backend::DocumentBackend>::active_sheet(self);
        let mut batch = Batch { active: Some(active_before), ..Batch::default() };
        self.um.pause_evaluation();
        let mut failure = None;
        for op in ops {
            if let Err(error) = self.apply_op(op, &mut batch) {
                failure = Some(error);
                break;
            }
        }
        if let Some(error) = failure {
            for _ in 0..batch.iron {
                let _ = self.um.undo();
            }
            let _ = self.um.flush_send_queue();
            self.meta = meta_before;
            self.um.resume_evaluation();
            if batch.iron > 0 {
                self.um.evaluate();
                // IronCalc dropped its redo list when the batch started.
                self.history.redo.clear();
            }
            self.set_active(active_before);
            return Err(error);
        }
        self.um.resume_evaluation();
        if batch.recalc && batch.iron > 0 {
            self.um.evaluate();
        }
        let active_after = batch.active.filter(|id| self.sheet_index(*id).is_ok()).unwrap_or(active_before);
        self.set_active(active_after);
        let active_after = <Self as crate::engine::backend::DocumentBackend>::active_sheet(self);

        let meta_changed = self.meta != meta_before;
        if batch.iron > 0 || meta_changed {
            self.history.undo.push(Step {
                iron: batch.iron,
                meta_before,
                meta_after: self.meta.clone(),
                selection: batch.selection.clone(),
                scope: batch.scope.clone(),
                recalc: batch.recalc,
                active_before,
                active_after,
            });
            if self.history.undo.len() > MAX_STEPS {
                // The IronCalc entries of the dropped step stay below ours and
                // are never replayed.
                self.history.undo.remove(0);
            }
            self.history.redo.clear();
        }
        if active_after != active_before {
            batch.scope.sheets = true;
        }
        let events = self.scope_events(&batch.scope, batch.recalc, false);
        let _ = started;
        Ok(ApplyOutcome {
            selection: batch.selection,
            created: batch.created,
            affected: batch.affected,
            events,
        })
    }

    pub(crate) fn undo_impl(&mut self) -> EngineResult<ApplyOutcome> {
        let Some(step) = self.history.undo.pop() else {
            return Ok(ApplyOutcome::default());
        };
        self.replay(&step, true)?;
        let outcome = ApplyOutcome {
            selection: step.selection.clone(),
            created: Vec::new(),
            affected: 0,
            events: self.scope_events(&step.scope, step.recalc, true),
        };
        self.history.redo.push(step);
        Ok(outcome)
    }

    pub(crate) fn redo_impl(&mut self) -> EngineResult<ApplyOutcome> {
        let Some(step) = self.history.redo.pop() else {
            return Ok(ApplyOutcome::default());
        };
        self.replay(&step, false)?;
        let outcome = ApplyOutcome {
            selection: step.selection.clone(),
            created: Vec::new(),
            affected: 0,
            events: self.scope_events(&step.scope, step.recalc, false),
        };
        self.history.undo.push(step);
        Ok(outcome)
    }

    fn replay(&mut self, step: &Step, undo: bool) -> EngineResult<()> {
        let _ = self.um.flush_send_queue();
        self.um.pause_evaluation();
        let mut result = Ok(());
        for _ in 0..step.iron {
            let r = if undo { self.um.undo() } else { self.um.redo() };
            if let Err(e) = r {
                result = Err(ic_error(e));
                break;
            }
        }
        let _ = self.um.flush_send_queue();
        self.um.resume_evaluation();
        if step.iron > 0 && step.recalc {
            self.um.evaluate();
        }
        self.meta = if undo { step.meta_before.clone() } else { step.meta_after.clone() };
        self.set_active(if undo { step.active_before } else { step.active_after });
        result
    }

    pub(crate) fn set_active(&mut self, sheet: SheetId) {
        if let Ok(index) = self.sheet_index(sheet) {
            let _ = self.um.set_selected_sheet(index);
        }
    }

    /// Invalidation events for a scope. `reverse` inverts structure events (undo).
    fn scope_events(&mut self, scope: &Scope, recalc: bool, reverse: bool) -> Vec<EngineEvent> {
        let doc = 0; // filled in by the actor
        let mut events = Vec::new();
        let mut data = scope.data.clone();
        let mut info = scope.info.clone();

        let structure: Vec<_> = if reverse {
            scope
                .structure
                .iter()
                .rev()
                .map(|(sheet, axis, op, index, count)| {
                    let op = if *op == StructureOp::Insert { StructureOp::Delete } else { StructureOp::Insert };
                    (*sheet, *axis, op, *index, *count)
                })
                .collect()
        } else {
            scope.structure.clone()
        };
        for (sheet, axis, op, index, count) in structure {
            if self.sheet_index(sheet).is_err() {
                continue;
            }
            events.push(EngineEvent::Structure { doc, sheet, axis, op, index, count });
            data.insert(sheet);
            info.insert(sheet);
        }

        // With formulas anywhere, a value edit can change any sheet that has
        // formulas: refetch them whole. Without formulas, only the edited ranges.
        let formula_sheets: Vec<SheetId> = if recalc {
            let model = self.model();
            model
                .workbook
                .worksheets
                .iter()
                .enumerate()
                .filter(|(i, _)| model.parsed_formulas.get(*i).is_some_and(|f| !f.is_empty()))
                .map(|(_, ws)| ws.sheet_id)
                .collect()
        } else {
            Vec::new()
        };
        let any_formulas = !formula_sheets.is_empty();
        data.extend(formula_sheets);
        let mut cells: BTreeMap<SheetId, Vec<CellRange>> = BTreeMap::new();
        for (sheet, ranges) in &scope.cells {
            if (any_formulas && recalc) || reverse || data.contains(sheet) {
                data.insert(*sheet);
            } else {
                cells.insert(*sheet, ranges.clone());
            }
        }
        for sheet in info {
            if self.sheet_index(sheet).is_ok() {
                let version = self.bump_info(sheet);
                events.push(EngineEvent::SheetInfo { doc, sheet, version });
            }
        }
        for sheet in data {
            if self.sheet_index(sheet).is_ok() {
                events.push(EngineEvent::SheetData { doc, sheet });
            }
        }
        for (sheet, ranges) in cells {
            if self.sheet_index(sheet).is_ok() {
                events.push(EngineEvent::Cells { doc, sheet, ranges });
            }
        }
        if scope.sheets {
            let sheets = self.sheet_metas();
            let active_sheet = <Self as crate::engine::backend::DocumentBackend>::active_sheet(self);
            events.push(EngineEvent::Sheets { doc, sheets, active_sheet });
        }
        for sheet in &scope.charts {
            if self.sheet_index(*sheet).is_ok() {
                events.push(EngineEvent::Charts { doc, sheet: *sheet });
            }
        }
        events
    }
}
