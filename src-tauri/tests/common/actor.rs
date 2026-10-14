//! Drives the real engine actor (`engine::actor::Engine`): every call runs on
//! the engine thread exactly as a Tauri command would, and every event the
//! actor emits is recorded for assertions.

use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::time::{Duration, Instant};

use sheetlight_lib::engine::actor::{Engine, EngineState};
use sheetlight_lib::engine::backend::EventSink;
use sheetlight_lib::engine::types::*;

/// Minimal executor for the actor's oneshot replies (no tokio runtime needed).
pub fn block_on<F: Future>(future: F) -> F::Output {
    struct Unpark(std::thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
            return v;
        }
        std::thread::park();
    }
}

pub struct Actor {
    engine: Engine,
    events: Arc<Mutex<Vec<EngineEvent>>>,
}

impl Default for Actor {
    fn default() -> Self {
        Self::start()
    }
}

impl Actor {
    pub fn start() -> Self {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink: EventSink = {
            let events = events.clone();
            Arc::new(move |e| events.lock().unwrap().push(e))
        };
        Self { engine: Engine::start(sink), events }
    }

    pub fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut EngineState) -> EngineResult<T> + Send + 'static,
    ) -> EngineResult<T> {
        block_on(self.engine.call(f))
    }

    /// Drains the recorded events.
    pub fn take_events(&self) -> Vec<EngineEvent> {
        std::mem::take(&mut *self.events.lock().unwrap())
    }

    pub fn new_document(&self) -> DocumentInfo {
        self.call(|s| s.new_document()).expect("newDocument")
    }

    /// `openDocument`, then waits for a streaming CSV to finish loading.
    pub fn open(&self, path: &Path) -> EngineResult<DocumentInfo> {
        self.open_with(path, None)
    }

    pub fn open_with(&self, path: &Path, options: Option<OpenOptions>) -> EngineResult<DocumentInfo> {
        let p = path.to_string_lossy().into_owned();
        let info = self.call(move |s| s.open_document(&p, options))?;
        Ok(if info.loading { self.wait_loaded(info.doc, Duration::from_secs(120)) } else { info })
    }

    pub fn wait_loaded(&self, doc: DocumentId, timeout: Duration) -> DocumentInfo {
        let deadline = Instant::now() + timeout;
        loop {
            let info = self.info(doc);
            if !info.loading {
                return info;
            }
            assert!(Instant::now() < deadline, "document {doc} still loading after {timeout:?}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn info(&self, doc: DocumentId) -> DocumentInfo {
        self.call(move |s| s.document_info(doc)).expect("getDocumentInfo")
    }

    pub fn save(&self, doc: DocumentId, path: &Path, options: SaveOptions) -> EngineResult<SaveResult> {
        let p = path.to_string_lossy().into_owned();
        self.call(move |s| s.save_document(doc, &p, options))
    }

    pub fn save_as(&self, doc: DocumentId, path: &Path, format: SaveFormat) -> SaveResult {
        self.save(doc, path, SaveOptions { format, sheet: None, csv: None })
            .unwrap_or_else(|e| panic!("save {}: {e}", path.display()))
    }

    pub fn close(&self, doc: DocumentId) {
        self.call(move |s| {
            s.close_document(doc);
            Ok(())
        })
        .unwrap();
    }

    pub fn apply(&self, doc: DocumentId, ops: Vec<EngineOp>) -> EngineResult<ApplyResult> {
        self.call(move |s| s.apply(doc, &ops))
    }

    pub fn undo(&self, doc: DocumentId) -> ApplyResult {
        self.call(move |s| s.undo(doc)).expect("undo")
    }

    pub fn redo(&self, doc: DocumentId) -> ApplyResult {
        self.call(move |s| s.redo(doc)).expect("redo")
    }

    pub fn cell(&self, doc: DocumentId, sheet: SheetId, row: u32, col: u32) -> CellDetails {
        self.try_cell(doc, sheet, CellAddress { row, col }).expect("getCell")
    }

    pub fn try_cell(&self, doc: DocumentId, sheet: SheetId, at: CellAddress) -> EngineResult<CellDetails> {
        self.call(move |s| s.cell(doc, sheet, at))
    }

    pub fn sheet_info(&self, doc: DocumentId, sheet: SheetId) -> SheetInfo {
        self.call(move |s| s.sheet_info(doc, sheet)).expect("getSheetInfo")
    }

    /// Sets one cell (canonical input) as its own undo step.
    pub fn set(&self, doc: DocumentId, sheet: SheetId, row: u32, col: u32, input: &str) -> ApplyResult {
        let cells = vec![CellInput { row, col, input: input.to_string(), num_fmt: None }];
        self.apply(doc, vec![EngineOp::SetCells { sheet, cells }]).expect("setCells")
    }
}

/// Unique scratch directory under the cargo target dir (no tempfile crate).
pub fn scratch_dir(name: &str) -> std::path::PathBuf {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("{name}-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}
