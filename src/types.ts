export type FrameId = string;
export type StyleId = string;
export type DocumentId = string;

export type FrameType = "text" | "image" | "rectangle" | "line";

export interface DocumentStateDelta {
  changed_frames?: Array<{
    id: FrameId;
    bounds?: [number, number, number, number];
    applied_paragraph_style?: string;
    applied_image_path?: string;
    applied_parent_name?: string;        // from override_parent_item_on_page
    applied_character_style_range?: {    // from apply_character_style_to_range
      character_style_name: string;
      start_index: number;
      end_index: number;
    };
    inset_mm?: { top: number; left: number; bottom: number; right: number };  // from set_frame_inset
    columns?: { count: number; gutter_mm: number };                           // from set_frame_columns
    threaded_to_frame_id?: FrameId;                                           // from thread_text_frames
  }>;
  new_frames?: Array<{ id: FrameId; type: FrameType }>;
  removed_frame_ids?: FrameId[];
  new_page_ids?: string[];
  removed_page_ids?: string[];
  page_count?: number;
  changed_pages?: Array<{
    id: string;
    applied_parent_name?: string;
  }>;
  new_parent_spreads?: Array<{
    name: string;
    page_count: number;       // 1 (single) or 2 (facing)
  }>;
  new_character_styles?: Array<{ name: string }>;   // from define_character_style
  new_paragraph_styles?: Array<{ name: string }>;   // from define_paragraph_style (refactor #74)
  new_swatches?: Array<{ name: string }>;            // from create_swatch
}

export interface SuccessEnvelope<T> {
  ok: true;
  result?: T;
  document_state_delta?: DocumentStateDelta;
  warnings?: string[];
}

export interface FailureEnvelope {
  ok: false;
  error: ToolError;
}

export type Envelope<T = unknown> = SuccessEnvelope<T> | FailureEnvelope;

export interface ToolError {
  kind: ErrorKind;
  message: string;
  // Optional kind-specific fields
  stack?: string;
  entity?: string;
  id?: string;
  // B8: write-guard fields
  existing_path?: string;
  suggested_path?: string;
  reason?: WriteRefusalReason;
}

export type ErrorKind =
  | "script_error"
  | "app_not_available"
  | "not_found"
  | "name_collision"
  | "io_error"
  | "timeout"
  | "invalid_args"
  | "foreign_document_open"   // B8: a foreign document is open when only owned ones are expected
  | "pdf_replace_blocked"     // B8: export-pdf refused because target already exists
  | "write_not_authorized";   // B8: assertWriteAllowed failed (forged/reused/mismatched decision)

/**
 * B8: Reason codes returned on name_collision and related refusals.
 * These fields appear in ToolError.reason when kind === "name_collision"
 * or kind === "write_not_authorized".
 */
export type WriteRefusalReason =
  | "path_not_absolute"        // path gate: relative, bare ~, ~user, .. segment, null byte
  | "wrong_extension"          // path gate: not .indd / .pdf
  | "parent_missing"           // path gate: parent directory not found
  | "symlink_target"           // path gate / lstat: path is a symlink
  | "not_regular_file"         // path gate / lstat: path exists but is not a regular file
  | "uncertain"                // any syscall error at the gate; also used for write-outcome uncertainty
  | "not_owned"                // registry: no record of this path in this session
  | "fingerprint_mismatch"     // registry: file changed externally (dev/ino/size/mtimeMs/ctimeMs)
  | "document_mismatch"        // registry: different documentId or tool
  | "path_changed"             // registry: document now at a different path than recorded
  | "name_truncated";          // name computation: base name truncated to fit 255-byte limit
