//! Input-size limits, kept in one place so the three enforcement points don't
//! drift apart. They guard different resources and are deliberately different
//! values — do not collapse them into one.

/// Largest PDF LingoPane will read into memory at all (drag-and-drop, file
/// open). Above this the file is rejected before any processing.
pub const MAX_PDF_BYTES: usize = 512 * 1024 * 1024;

/// Largest PDF handed to the Docling Python subprocess. Lower than
/// [`MAX_PDF_BYTES`] because Docling holds the whole document plus model
/// activations resident while it works.
pub const MAX_DOCLING_PDF_BYTES: usize = 200 * 1024 * 1024;

/// Per-page translation guards. A page with more blocks or characters than
/// this is refused rather than sent to the model as one oversized request.
pub const MAX_TRANSLATION_BLOCKS_PER_PAGE: usize = 400;
pub const MAX_TRANSLATION_CHARS_PER_PAGE: usize = 60_000;
