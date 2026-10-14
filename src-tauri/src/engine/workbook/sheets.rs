//! Sheet operations and Excel's sheet name rules (Spanish messages).

use ironcalc_base::types::{Color, SheetState};

use super::history::Batch;
use super::ops::invalid;
use super::{styles, WorkbookBackend};
use crate::engine::types::*;

fn name_error(message: &str) -> EngineError {
    EngineError::new(EngineErrorCode::SheetName, message)
}

/// Validates a sheet name like Excel. `others` are the other sheets' names.
pub fn validate_sheet_name<'a>(name: &str, mut others: impl Iterator<Item = &'a str>) -> EngineResult<()> {
    if name.trim().is_empty() {
        return Err(name_error("El nombre de la hoja no puede estar vacío."));
    }
    if name.chars().count() > 31 {
        return Err(name_error("El nombre de la hoja no puede tener más de 31 caracteres."));
    }
    if name.chars().any(|c| matches!(c, '\\' | '/' | '?' | '*' | '[' | ']' | ':')) {
        return Err(name_error("El nombre de la hoja no puede contener los caracteres \\ / ? * [ ] :"));
    }
    if name.starts_with('\'') || name.ends_with('\'') {
        return Err(name_error("El nombre de la hoja no puede empezar ni terminar con un apóstrofo."));
    }
    if name.eq_ignore_ascii_case("historial") || name.eq_ignore_ascii_case("history") {
        return Err(name_error("«Historial» es un nombre reservado."));
    }
    let lower = name.to_lowercase();
    if others.any(|other| other.to_lowercase() == lower) {
        return Err(name_error("Ya existe una hoja con ese nombre."));
    }
    Ok(())
}

/// First free `Hoja{n}` name.
pub fn next_sheet_name<'a>(existing: impl Iterator<Item = &'a str> + Clone) -> String {
    let mut n = 1;
    loop {
        let candidate = format!("Hoja{n}");
        if !existing.clone().any(|e| e.eq_ignore_ascii_case(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

/// `Ventas (2)`, `Ventas (3)`… within 31 characters.
pub fn copy_name<'a>(base: &str, existing: impl Iterator<Item = &'a str> + Clone) -> String {
    let mut n = 2;
    loop {
        let suffix = format!(" ({n})");
        let keep = 31usize.saturating_sub(suffix.chars().count());
        let stem: String = base.chars().take(keep).collect();
        let candidate = format!("{stem}{suffix}");
        if !existing.clone().any(|e| e.eq_ignore_ascii_case(&candidate)) {
            return candidate;
        }
        n += 1;
    }
}

impl WorkbookBackend {
    fn sheet_names(&self) -> Vec<String> {
        self.model().workbook.worksheets.iter().map(|ws| ws.name.clone()).collect()
    }

    fn visible_count(&self) -> usize {
        self.model().workbook.worksheets.iter().filter(|ws| ws.state == SheetState::Visible).count()
    }

    pub(crate) fn op_add_sheet(&mut self, b: &mut Batch, name: Option<&str>, index: Option<u32>) -> EngineResult<()> {
        let names = self.sheet_names();
        let name = match name {
            Some(name) => {
                validate_sheet_name(name, names.iter().map(String::as_str))?;
                name.to_string()
            }
            None => next_sheet_name(names.iter().map(String::as_str)),
        };
        self.ic(b, |um| um.new_sheet())?;
        let last = self.model().workbook.worksheets.len() as u32 - 1;
        let id = self.sheet_id_at(last).ok_or_else(super::sheet_not_found)?;
        if self.model().workbook.worksheets[last as usize].name != name {
            self.ic(b, |um| um.rename_sheet(last, &name))?;
        }
        if let Some(index) = index {
            let target = index.min(last);
            if target != last {
                self.ic(b, |um| um.move_sheet(last, target))?;
            }
        }
        self.extra_mut(id);
        b.created.push(id);
        b.active = Some(id);
        b.scope.sheets = true;
        Ok(())
    }

    pub(crate) fn op_delete_sheet(&mut self, b: &mut Batch, sheet: SheetId) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let visible = self.model().workbook.worksheets[index as usize].state == SheetState::Visible;
        if visible && self.visible_count() <= 1 {
            return Err(invalid("Un libro debe contener al menos una hoja visible."));
        }
        let was_active = b.active == Some(sheet);
        self.ic(b, |um| um.delete_sheet(index))?;
        if was_active {
            // Excel activates the next visible sheet (or the previous one).
            let sheets = &self.model().workbook.worksheets;
            let pick = (index as usize..sheets.len())
                .chain((0..index as usize).rev())
                .find(|i| sheets[*i].state == SheetState::Visible)
                .map(|i| sheets[i].sheet_id);
            b.active = pick;
        }
        b.scope.sheets = true;
        b.recalc = true;
        b.scope.charts.insert(sheet);
        Ok(())
    }

    pub(crate) fn op_rename_sheet(&mut self, b: &mut Batch, sheet: SheetId, name: &str) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let names = self.sheet_names();
        let current = names[index as usize].clone();
        if current == name {
            return Ok(());
        }
        validate_sheet_name(
            name,
            names.iter().enumerate().filter(|(i, _)| *i != index as usize).map(|(_, n)| n.as_str()),
        )?;
        self.ic(b, |um| um.rename_sheet(index, name))?;
        // Formulas referencing the sheet are rewritten by IronCalc.
        b.scope.sheets = true;
        for ws in &self.model().workbook.worksheets {
            b.scope.data.insert(ws.sheet_id);
        }
        Ok(())
    }

    pub(crate) fn op_move_sheet(&mut self, b: &mut Batch, sheet: SheetId, index: u32) -> EngineResult<()> {
        let from = self.sheet_index(sheet)?;
        let last = self.model().workbook.worksheets.len() as u32 - 1;
        let to = index.min(last);
        if from != to {
            self.ic(b, |um| um.move_sheet(from, to))?;
        }
        b.scope.sheets = true;
        Ok(())
    }

    pub(crate) fn op_duplicate_sheet(&mut self, b: &mut Batch, sheet: SheetId) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let names = self.sheet_names();
        let source_name = names[index as usize].clone();
        let new_name = copy_name(&source_name, names.iter().map(String::as_str));
        self.ic(b, |um| um.duplicate_sheet(index))?;
        let new_index = index + 1;
        let id = self.sheet_id_at(new_index).ok_or_else(super::sheet_not_found)?;
        if self.model().workbook.worksheets[new_index as usize].name != new_name {
            self.ic(b, |um| um.rename_sheet(new_index, &new_name))?;
        }
        let mut extra = self.extra(sheet).cloned().unwrap_or_default();
        extra.original_index = None;
        for chart in &mut extra.charts {
            chart.id = self.next_chart_id;
            self.next_chart_id += 1;
            chart.draft.sheet = id;
            chart.from_file = false;
            for series in &mut chart.draft.series {
                for reference in [&mut series.name_ref, &mut series.categories_ref].into_iter().flatten() {
                    *reference = retarget_ref(reference, &source_name, &new_name);
                }
                series.values_ref = retarget_ref(&series.values_ref, &source_name, &new_name);
            }
        }
        self.meta.sheets.insert(id, extra);
        b.created.push(id);
        b.active = Some(id);
        b.scope.sheets = true;
        b.scope.charts.insert(id);
        Ok(())
    }

    pub(crate) fn op_sheet_hidden(&mut self, b: &mut Batch, sheet: SheetId, hidden: bool) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let state = self.model().workbook.worksheets[index as usize].state.clone();
        if hidden {
            if state != SheetState::Visible {
                return Ok(());
            }
            if self.visible_count() <= 1 {
                return Err(invalid("Un libro debe contener al menos una hoja visible."));
            }
            self.ic(b, |um| um.hide_sheet(index))?;
            if b.active == Some(sheet) {
                let active = self.um.get_selected_sheet();
                b.active = self.sheet_id_at(active);
            }
        } else {
            if state == SheetState::Visible {
                return Ok(());
            }
            self.ic(b, |um| um.unhide_sheet(index))?;
        }
        b.scope.sheets = true;
        Ok(())
    }

    pub(crate) fn op_sheet_color(&mut self, b: &mut Batch, sheet: SheetId, color: Option<&str>) -> EngineResult<()> {
        let index = self.sheet_index(sheet)?;
        let color = match color {
            Some(c) => styles::color_in(c).map_err(|e| invalid(&e))?,
            None => Color::None,
        };
        self.ic(b, |um| um.set_sheet_color(index, &color))?;
        b.scope.sheets = true;
        Ok(())
    }
}

/// `Ventas!$A$1:$A$5` → `'Ventas (2)'!$A$1:$A$5` when the sheet part matches.
fn retarget_ref(reference: &str, from: &str, to: &str) -> String {
    let Some((sheet, cells)) = reference.rsplit_once('!') else {
        return reference.to_string();
    };
    let bare = sheet.trim_matches('\'').replace("''", "'");
    if !bare.eq_ignore_ascii_case(from) {
        return reference.to_string();
    }
    let needs_quotes = to.chars().any(|c| !c.is_alphanumeric() && c != '_') || to.chars().next().is_some_and(|c| c.is_ascii_digit());
    if needs_quotes {
        format!("'{}'!{cells}", to.replace('\'', "''"))
    } else {
        format!("{to}!{cells}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excel_sheet_name_rules() {
        let others = ["Hoja1", "Ventas"];
        let check = |name: &str| validate_sheet_name(name, others.iter().copied());
        assert!(check("Resumen 2026").is_ok());
        assert_eq!(check("").unwrap_err().code, EngineErrorCode::SheetName);
        assert_eq!(check("   ").unwrap_err().message, "El nombre de la hoja no puede estar vacío.");
        assert!(check(&"x".repeat(32)).unwrap_err().message.contains("31"));
        assert!(check(&"x".repeat(31)).is_ok());
        for bad in ["a/b", "a\\b", "a?", "a*", "[a]", "a:b"] {
            assert!(check(bad).is_err(), "{bad}");
        }
        assert!(check("'hola").is_err());
        assert!(check("hola'").is_err());
        assert!(check("ho'la").is_ok());
        assert_eq!(check("ventas").unwrap_err().message, "Ya existe una hoja con ese nombre.");
        assert!(check("Historial").is_err());
    }

    #[test]
    fn generated_names() {
        assert_eq!(next_sheet_name(["Hoja1", "Hoja2"].iter().copied()), "Hoja3");
        assert_eq!(copy_name("Ventas", ["Ventas", "Ventas (2)"].iter().copied()), "Ventas (3)");
        assert_eq!(retarget_ref("Ventas!$B$2:$B$5", "Ventas", "Ventas (2)"), "'Ventas (2)'!$B$2:$B$5");
        assert_eq!(retarget_ref("Otra!$B$2", "Ventas", "X"), "Otra!$B$2");
    }
}
