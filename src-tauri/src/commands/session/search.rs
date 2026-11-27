//! Session search functions

use crate::commands::stats::session_files;
use crate::models::{ClaudeMessage, RawLogEntry};
use crate::utils::find_line_ranges;
use aho_corasick::AhoCorasick;
use chrono::{DateTime, Utc};
use lru::LruCache;
use memmap2::Mmap;
use rayon::prelude::*;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::SystemTime;
use uuid::Uuid;

/// Initial buffer capacity for JSON parsing (4KB covers most messages)
const PARSE_BUFFER_INITIAL_CAPACITY: usize = 4096;

/// Initial capacity for search results (most searches find few matches)
const SEARCH_RESULTS_INITIAL_CAPACITY: usize = 8;

/// LRU cache capacity — distinct (`claude_path`, query) pairs.
const SEARCH_CACHE_CAPACITY: usize = 64;

/// Upper bound on cached raw matches per query entry; a query matching huge
/// portions of the corpus is computed but not stored, keeping worst-case
/// memory bounded.
const MAX_CACHED_MATCHES_PER_QUERY: usize = 10_000;

/// Error a cancelled search returns. `search_all_providers` matches on it to
/// stop at once instead of logging it and moving on to the next provider.
pub const SEARCH_CANCELLED: &str = "search cancelled";

/// Cancel groups remembered at once. A group pushed out of the table only
/// misses cancels sent after that: a running search keeps its own counter.
const CANCEL_GROUP_CAPACITY: usize = 256;

/// Longest cancel group name kept in the table (the frontend sends about 50
/// bytes), so a client cannot make the table hold huge keys.
const MAX_CANCEL_GROUP_LEN: usize = 128;

/// Lines scanned between two cancel checks inside one file.
const CANCEL_CHECK_INTERVAL: usize = 256;

/// Files written more than this long before a date range starts are not
/// read: the newest message of a session file is never newer than its mtime
/// by more than a minute (measured over 20,712 files), so such a file has no
/// message in the range.
const PREFILTER_MTIME_MARGIN_HOURS: i64 = 1;

lazy_static::lazy_static! {
    static ref ERROR_MATCHER: AhoCorasick = build_matcher("error");
    static ref SEARCH_CACHE: Mutex<LruCache<u64, CachedQuerySearch>> =
        Mutex::new(LruCache::new(NonZeroUsize::new(SEARCH_CACHE_CAPACITY).expect("non-zero")));
    static ref CANCEL_GROUPS: Mutex<LruCache<String, Arc<AtomicU64>>> =
        Mutex::new(LruCache::new(NonZeroUsize::new(CANCEL_GROUP_CAPACITY).expect("non-zero")));
}

/// Lets a newer search, or an explicit `cancel_search`, stop an older search
/// of the same group.
///
/// Commands may arrive in any order, so a group keeps only the highest value
/// it has seen: a search raises it to its own seq, a cancel of seq `n` raises
/// it to `n + 1`, and a search stays live while the value equals its seq.
/// A late cancel therefore never stops a newer search, and a search that
/// arrives after a newer one (or after its own cancel) starts cancelled.
#[derive(Clone)]
pub struct SearchCancelToken {
    latest: Arc<AtomicU64>,
    seq: u64,
}

impl SearchCancelToken {
    /// Register a search as the newest of its group. Without both a group
    /// and a seq, or with a group longer than `MAX_CANCEL_GROUP_LEN`, there
    /// is no token, and the search is never cancelled.
    pub fn begin(group: Option<&str>, seq: Option<u64>) -> Option<Self> {
        let (group, seq) = (group?, seq?);
        let latest = cancel_group_counter(group)?;
        latest.fetch_max(seq, Ordering::AcqRel);
        Some(Self { latest, seq })
    }

    pub fn is_cancelled(&self) -> bool {
        self.latest.load(Ordering::Acquire) > self.seq
    }
}

fn is_cancelled(token: Option<&SearchCancelToken>) -> bool {
    token.is_some_and(SearchCancelToken::is_cancelled)
}

/// `Err(SEARCH_CANCELLED)` once the search holding `token` is stale.
pub fn ensure_search_active(token: Option<&SearchCancelToken>) -> Result<(), String> {
    if is_cancelled(token) {
        Err(SEARCH_CANCELLED.to_string())
    } else {
        Ok(())
    }
}

/// The group's counter, created at 0 on first use. Tokens hold their own
/// `Arc`, so evicting a group never touches a running search. A group longer
/// than `MAX_CANCEL_GROUP_LEN` has no counter and never enters the table.
fn cancel_group_counter(group: &str) -> Option<Arc<AtomicU64>> {
    if group.len() > MAX_CANCEL_GROUP_LEN {
        return None;
    }
    let mut groups = CANCEL_GROUPS.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(counter) = groups.get(group) {
        return Some(Arc::clone(counter));
    }
    let counter = Arc::new(AtomicU64::new(0));
    groups.put(group.to_string(), Arc::clone(&counter));
    Some(counter)
}

/// Stop every search of `group` whose seq is `seq` or lower. (`u64::MAX`
/// saturates and cannot be cancelled; the frontend's seqs never get there.)
/// A group too long to have searches at all is left alone.
pub(crate) fn cancel_search_group(group: &str, seq: u64) {
    if let Some(counter) = cancel_group_counter(group) {
        counter.fetch_max(seq.saturating_add(1), Ordering::AcqRel);
    }
}

/// Stop the searches of `cancel_group` started with a seq up to `cancel_seq`
/// (the frontend calls this when the query it was typing has moved on).
#[tauri::command]
pub async fn cancel_search(cancel_group: String, cancel_seq: u64) -> Result<(), String> {
    if cancel_group.len() > MAX_CANCEL_GROUP_LEN {
        return Err(format!(
            "cancel group is longer than {MAX_CANCEL_GROUP_LEN} bytes"
        ));
    }
    cancel_search_group(&cancel_group, cancel_seq);
    Ok(())
}

/// (size, mtime) identity of a session file, captured BEFORE scanning so a
/// concurrent append can never be cached under a newer signature (worst
/// case: an unnecessary re-scan on the next call). Same validation scheme as
/// `stats::cache`, kept separate on purpose — the two caches must not couple.
#[derive(Clone, Copy, PartialEq, Eq)]
struct FileSignature {
    size: u64,
    mtime: Option<SystemTime>,
}

impl FileSignature {
    fn of(path: &Path) -> Option<Self> {
        let metadata = fs::metadata(path).ok()?;
        Some(Self {
            size: metadata.len(),
            mtime: metadata.modified().ok(),
        })
    }
}

/// Raw (unfiltered, untruncated) matches of one query in one file, valid
/// while the file's signature is unchanged.
#[derive(Clone)]
struct FileMatches {
    signature: FileSignature,
    matches: Arc<Vec<ClaudeMessage>>,
}

/// Per-file match sets for one (`claude_path`, query) pair. Filters and limit
/// are applied at serve time, so one entry answers every filter/limit
/// combination for its query.
struct CachedQuerySearch {
    files: HashMap<PathBuf, FileMatches>,
}

/// Serve-time state of one walked file: its captured signature (if the file
/// could be stat'ed) and its matches, filled from cache or by scanning.
type FileSlot = (Option<FileSignature>, Option<Arc<Vec<ClaudeMessage>>>);

/// Drop one file's cached matches from every cached query.
///
/// Needed for the session-rename commands, which REWRITE a session file via
/// temp+rename: a rewrite can produce the same byte size within the mtime
/// resolution window, which the `(size, mtime)` signature cannot distinguish
/// (append-only growth always changes the size, so the watcher path needs no
/// such hook). Hashing content instead would cost a full read per file per
/// search — defeating the cache — so targeted eviction at the rewrite site is
/// the cheap, precise fix.
pub fn evict_file_from_search_cache(path: &Path) {
    let Ok(mut cache) = SEARCH_CACHE.lock() else {
        return;
    };
    let canonical = path.canonicalize().ok();
    for (_, entry) in cache.iter_mut() {
        entry.files.remove(path);
        if let Some(ref canonical) = canonical {
            entry.files.remove(canonical);
        }
    }
}

fn cache_key(claude_path: &str, query: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    claude_path.hash(&mut hasher);
    query.to_lowercase().hash(&mut hasher);
    hasher.finish()
}

/// Recursively search for a query within a `serde_json::Value` using aho-corasick.
/// Case-insensitive matching without per-string heap allocation from `.to_lowercase()`.
#[inline]
fn search_in_value(value: &serde_json::Value, matcher: &AhoCorasick) -> bool {
    match value {
        serde_json::Value::String(s) => matcher.is_match(s),
        serde_json::Value::Array(arr) => arr.iter().any(|item| search_in_value(item, matcher)),
        serde_json::Value::Object(obj) => obj.values().any(|val| search_in_value(val, matcher)),
        _ => false,
    }
}

/// Build an aho-corasick matcher for case-insensitive single-pattern search.
/// Uses ASCII case-insensitive mode (sufficient for most search queries).
fn build_matcher(query: &str) -> AhoCorasick {
    AhoCorasick::builder()
        .ascii_case_insensitive(true)
        .build([query])
        .expect("single-pattern AhoCorasick build should never fail")
}

/// The project a session file belongs to: the directory directly under
/// `projects_root` (`~/.claude/projects`) that holds it, however deep.
/// That folder name is what a project filter sends.
///
/// Sessions lie at `[project-name]/[session-id].jsonl`; subagent and workflow
/// transcripts lie further down, under
/// `[project-name]/[session-id]/subagents/`. Naming them after a nearby
/// directory ("subagents", a workflow run) would group them under a project
/// that does not exist and keep a project filter from ever matching them.
///
/// A file lying directly in `projects_root` belongs to no project. A path
/// that does not start with `projects_root` (the walk never yields one) is
/// named after its parent directory instead.
fn extract_project_name(projects_root: &Path, file_path: &Path) -> Option<String> {
    let Ok(relative) = file_path.strip_prefix(projects_root) else {
        return project_name_from_parent(file_path);
    };
    let mut components = relative.components();
    let first = components.next()?;
    // Nothing after the first component: it is the file itself.
    components.next()?;
    first.as_os_str().to_str().map(str::to_string)
}

/// The parent directory's name, or for a `[session-id]/subagents/` file the
/// directory above the session's.
fn project_name_from_parent(file_path: &Path) -> Option<String> {
    let mut dir = file_path.parent()?;
    if dir.file_name().is_some_and(|name| name == "subagents") {
        dir = dir.parent()?.parent()?;
    }
    dir.file_name()
        .and_then(|n| n.to_str())
        .map(std::string::ToString::to_string)
}

/// Search for messages matching the query in a single file
///
/// Uses a reusable buffer to avoid repeated heap allocations during JSON parsing.
/// Accepts a pre-built `AhoCorasick` matcher to avoid rebuilding per file.
///
/// A row without a timestamp takes `fallback_timestamp` (the file's mtime
/// from its signature) so the date pre-filter, which judges a file by that
/// mtime, can never disagree with the date filter about it; only a file whose
/// mtime could not be read falls back to "now".
///
/// Returns `None` when `cancel` turns stale mid-file: a partly read file must
/// never be taken for a complete one.
#[allow(unsafe_code)] // Required for mmap performance optimization
fn search_in_file(
    projects_root: &Path,
    file_path: &PathBuf,
    matcher: &AhoCorasick,
    fallback_timestamp: Option<SystemTime>,
    cancel: Option<&SearchCancelToken>,
) -> Option<Vec<ClaudeMessage>> {
    let project_name = extract_project_name(projects_root, file_path);
    let fallback_timestamp =
        fallback_timestamp.map(|mtime| DateTime::<Utc>::from(mtime).to_rfc3339());

    let file = match fs::File::open(file_path) {
        Ok(f) => f,
        Err(_) => return Some(Vec::new()),
    };

    // SAFETY: We're only reading the file, and the file handle is kept open
    // for the duration of the mmap's lifetime. Session files are append-only.
    let mmap = match unsafe { Mmap::map(&file) } {
        Ok(m) => m,
        Err(_) => return Some(Vec::new()),
    };

    // Use SIMD-accelerated line detection
    let line_ranges = find_line_ranges(&mmap);

    let mut results = Vec::with_capacity(SEARCH_RESULTS_INITIAL_CAPACITY);

    // Reusable buffer for simd-json parsing (requires mutable slice)
    // This avoids heap allocation per line
    let mut parse_buffer = Vec::with_capacity(PARSE_BUFFER_INITIAL_CAPACITY);

    for (line_num, (start, end)) in line_ranges.iter().enumerate() {
        if line_num % CANCEL_CHECK_INTERVAL == 0 {
            #[cfg(test)]
            run_cancel_check_hook(file_path, line_num);
            if is_cancelled(cancel) {
                return None;
            }
        }

        // Reuse buffer instead of allocating new Vec each iteration
        parse_buffer.clear();
        parse_buffer.extend_from_slice(&mmap[*start..*end]);

        let log_entry: RawLogEntry = match simd_json::serde::from_slice(&mut parse_buffer) {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        if log_entry.message_type != "user" && log_entry.message_type != "assistant" {
            continue;
        }

        let message_content = match &log_entry.message {
            Some(mc) => mc,
            None => continue,
        };

        // Use aho-corasick for case-insensitive matching without heap allocation
        let content_matches = match &message_content.content {
            serde_json::Value::String(s) => matcher.is_match(s),
            serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
                search_in_value(&message_content.content, matcher)
            }
            _ => false,
        };

        // Also search the tool-call payloads. The in-session FlexSearch index
        // covers `toolUseResult` (file contents, command stdout/stderr) and tool
        // names, so global search must too — otherwise a query that only appears
        // in a tool result is found inside a conversation but missed by the
        // global search (issue #394). `search_in_value` already recurses every
        // nested string (e.g. `toolUseResult.file.content`, `.stdout`).
        let matches = content_matches
            || log_entry
                .tool_use_result
                .as_ref()
                .is_some_and(|v| search_in_value(v, matcher))
            || log_entry
                .tool_use
                .as_ref()
                .is_some_and(|v| search_in_value(v, matcher));

        if !matches {
            continue;
        }

        let claude_message = ClaudeMessage {
            uuid: log_entry
                .uuid
                .unwrap_or_else(|| format!("{}-line-{}", Uuid::new_v4(), line_num + 1)),
            parent_uuid: log_entry.parent_uuid,
            session_id: log_entry
                .session_id
                .unwrap_or_else(|| "unknown-session".to_string()),
            timestamp: log_entry.timestamp.unwrap_or_else(|| {
                fallback_timestamp
                    .clone()
                    .unwrap_or_else(|| Utc::now().to_rfc3339())
            }),
            message_type: log_entry.message_type,
            content: Some(message_content.content.clone()),
            project_name: project_name.clone(),
            tool_use: log_entry.tool_use,
            tool_use_result: log_entry.tool_use_result,
            is_sidechain: log_entry.is_sidechain,
            usage: message_content.usage.clone(),
            role: Some(message_content.role.clone()),
            model: message_content.model.clone(),
            stop_reason: message_content.stop_reason.clone(),
            cost_usd: log_entry.cost_usd,
            duration_ms: log_entry.duration_ms,
            message_id: message_content.id.clone(),
            snapshot: None,
            is_snapshot_update: None,
            data: None,
            tool_use_id: None,
            parent_tool_use_id: None,
            operation: None,
            subtype: None,
            level: None,
            hook_count: None,
            hook_infos: None,
            stop_reason_system: None,
            prevented_continuation: None,
            compact_metadata: None,
            microcompact_metadata: None,
            is_compact_summary: None,
            provider: None,
            effort: log_entry.effort,
        };
        results.push(claude_message);
    }

    Some(results)
}

/// Default limit for search results
const DEFAULT_SEARCH_LIMIT: usize = 100;

fn has_tool_calls(message: &ClaudeMessage) -> bool {
    message.tool_use.is_some()
        || message.tool_use_result.is_some()
        || message
            .content
            .as_ref()
            .and_then(serde_json::Value::as_array)
            .map(|arr| {
                arr.iter().any(|item| {
                    item.get("type").and_then(serde_json::Value::as_str) == Some("tool_use")
                        || item.get("type").and_then(serde_json::Value::as_str)
                            == Some("tool_result")
                })
            })
            .unwrap_or(false)
}

fn has_errors(message: &ClaudeMessage) -> bool {
    message.message_type == "error"
        || message.level.as_deref() == Some("error")
        || message
            .stop_reason_system
            .as_deref()
            .map(|s| ERROR_MATCHER.is_match(s))
            .unwrap_or(false)
        || message
            .content
            .as_ref()
            .map(|v| search_in_value(v, &ERROR_MATCHER))
            .unwrap_or(false)
}

fn has_file_changes(message: &ClaudeMessage) -> bool {
    let Some(content) = message
        .content
        .as_ref()
        .and_then(serde_json::Value::as_array)
    else {
        return false;
    };

    content.iter().any(|item| {
        if item.get("type").and_then(serde_json::Value::as_str) != Some("tool_use") {
            return false;
        }

        matches!(
            item.get("name").and_then(serde_json::Value::as_str),
            Some("Write" | "Edit" | "MultiEdit" | "NotebookEdit")
        )
    })
}

fn parse_filter_date(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    value.as_str().and_then(|s| {
        DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|dt| dt.with_timezone(&Utc))
    })
}

fn filter_value_to_string(value: &serde_json::Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

pub(crate) fn validate_search_filters(filters: &serde_json::Value) -> Result<(), String> {
    let Some(obj) = filters.as_object() else {
        return Ok(());
    };

    let Some(date_range) = obj.get("dateRange").and_then(serde_json::Value::as_array) else {
        return Ok(());
    };

    if date_range.len() != 2 {
        return Err(format!(
            "Invalid dateRange filter: expected [start, end], got {} item(s)",
            date_range.len()
        ));
    }

    let start_raw = filter_value_to_string(&date_range[0]);
    let end_raw = filter_value_to_string(&date_range[1]);

    let Some(start_at) = parse_filter_date(&date_range[0]) else {
        return Err(format!(
            "Invalid dateRange start: {start_raw} (expected RFC3339 datetime)"
        ));
    };
    let Some(end_at) = parse_filter_date(&date_range[1]) else {
        return Err(format!(
            "Invalid dateRange end: {end_raw} (expected RFC3339 datetime)"
        ));
    };

    if start_at > end_at {
        return Err(format!(
            "Invalid dateRange filter: start ({start_raw}) is after end ({end_raw})"
        ));
    }

    Ok(())
}

fn matches_filters(message: &ClaudeMessage, filters: &serde_json::Value) -> bool {
    let Some(obj) = filters.as_object() else {
        return true;
    };

    if let Some(message_type) = obj.get("messageType").and_then(serde_json::Value::as_str) {
        if message_type != "all" && message.message_type != message_type {
            return false;
        }
    }

    if let Some(selected) = selected_projects(filters) {
        let Some(project_name) = message.project_name.as_deref() else {
            return false;
        };
        if !selected.contains(&project_name) {
            return false;
        }
    }

    if let Some(has_tool_calls_filter) =
        obj.get("hasToolCalls").and_then(serde_json::Value::as_bool)
    {
        let has_calls = has_tool_calls(message);
        if has_calls != has_tool_calls_filter {
            return false;
        }
    }

    if let Some(has_errors_filter) = obj.get("hasErrors").and_then(serde_json::Value::as_bool) {
        let has_message_error = has_errors(message);
        if has_message_error != has_errors_filter {
            return false;
        }
    }

    if let Some(has_file_changes_filter) = obj
        .get("hasFileChanges")
        .and_then(serde_json::Value::as_bool)
    {
        let has_message_file_changes = has_file_changes(message);
        if has_message_file_changes != has_file_changes_filter {
            return false;
        }
    }

    if let Some((start, end)) = date_range_bounds(filters) {
        let (Some(start_at), Some(end_at)) = (start, end) else {
            return false;
        };
        let message_ts = DateTime::parse_from_rfc3339(&message.timestamp)
            .ok()
            .map(|dt| dt.with_timezone(&Utc));
        match message_ts {
            Some(ts) if ts >= start_at && ts <= end_at => {}
            _ => return false,
        }
    }

    true
}

/// The projects a search is narrowed to: `None` unless `projects` holds at
/// least one string. Shared by `matches_filters` and the pre-filter so the
/// two can never read the filter differently.
fn selected_projects(filters: &serde_json::Value) -> Option<Vec<&str>> {
    let projects = filters.get("projects")?.as_array()?;
    let selected: Vec<&str> = projects
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect();
    (!selected.is_empty()).then_some(selected)
}

/// `[start, end]` of a date range; a bound that does not parse is `None`.
type DateRangeBounds = (Option<DateTime<Utc>>, Option<DateTime<Utc>>);

/// The parsed `[start, end]` of an active date range (an array of exactly two
/// items); either bound is `None` when it does not parse, which rejects every
/// message. Shared by `matches_filters` and the pre-filter.
fn date_range_bounds(filters: &serde_json::Value) -> Option<DateRangeBounds> {
    let date_range = filters.get("dateRange")?.as_array()?;
    (date_range.len() == 2).then(|| {
        (
            parse_filter_date(&date_range[0]),
            parse_filter_date(&date_range[1]),
        )
    })
}

/// Decides, before any read, which uncached files cannot add a single
/// message to the filtered result, so they are not read at all.
///
/// It reads the filters through the same helpers as `matches_filters`:
/// - project: every message of a file carries
///   `extract_project_name(projects_root, path)` (set in `search_in_file`
///   from the same root), so a file outside the selection is filtered out row
///   by row anyway.
/// - date: a file written more than `PREFILTER_MTIME_MARGIN_HOURS` before the
///   range starts has no message in it (rows without a timestamp take that
///   same mtime). An unparsable end rejects every message regardless.
///
/// A file whose signature or mtime is unknown is always read. A skipped file
/// keeps no cache entry, so a later, wider search reads it.
struct ScanPrefilter<'a> {
    projects_root: &'a Path,
    projects: Option<Vec<&'a str>>,
    written_before_cutoff: Option<SystemTime>,
}

impl<'a> ScanPrefilter<'a> {
    fn new(projects_root: &'a Path, filters: &'a serde_json::Value) -> Self {
        let written_before_cutoff = date_range_bounds(filters)
            .and_then(|(start, _)| start)
            .and_then(|start| {
                start.checked_sub_signed(chrono::Duration::hours(PREFILTER_MTIME_MARGIN_HOURS))
            })
            .map(SystemTime::from);
        Self {
            projects_root,
            projects: selected_projects(filters),
            written_before_cutoff,
        }
    }

    fn excludes(&self, path: &Path, signature: Option<FileSignature>) -> bool {
        let Some(mtime) = signature.and_then(|signature| signature.mtime) else {
            return false;
        };
        if let Some(projects) = &self.projects {
            let in_selection = extract_project_name(self.projects_root, path)
                .is_some_and(|name| projects.contains(&name.as_str()));
            if !in_selection {
                return true;
            }
        }
        self.written_before_cutoff
            .is_some_and(|cutoff| mtime < cutoff)
    }
}

pub fn apply_search_filters(
    messages: Vec<ClaudeMessage>,
    filters: &serde_json::Value,
) -> Vec<ClaudeMessage> {
    messages
        .into_iter()
        .filter(|message| matches_filters(message, filters))
        .collect()
}

/// Search messages across a Claude storage directory.
///
/// Walks and scans every session file synchronously, so it runs on the blocking
/// pool. Search is the one command a user is most likely to fire repeatedly,
/// and holding the runtime meant each keystroke-triggered search froze
/// everything else until it finished.
///
/// With both `cancel_group` and `cancel_seq`, the search becomes the newest of
/// its group and stops with `Err(SEARCH_CANCELLED)` once a newer search or a
/// `cancel_search` reaches its seq (see [`SearchCancelToken`]).
#[tauri::command]
pub async fn search_messages(
    claude_path: String,
    query: String,
    filters: serde_json::Value,
    limit: Option<usize>,
    cancel_group: Option<String>,
    cancel_seq: Option<u64>,
) -> Result<Vec<ClaudeMessage>, String> {
    let cancel = SearchCancelToken::begin(cancel_group.as_deref(), cancel_seq);
    search_messages_with_cancel(claude_path, query, filters, limit, cancel).await
}

/// `search_messages` under a token its caller already registered, so a
/// command that searches several roots (`search_all_providers`) checks one
/// token instead of advancing its group once per root.
pub(crate) async fn search_messages_with_cancel(
    claude_path: String,
    query: String,
    filters: serde_json::Value,
    limit: Option<usize>,
    cancel: Option<SearchCancelToken>,
) -> Result<Vec<ClaudeMessage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_messages_blocking(claude_path, query, filters, limit, cancel.as_ref())
    })
    .await
    .map_err(|e| format!("Task join error: {e}"))?
}

/// The search itself. Separate from the command so the body stays at one indent
/// level and the wrapper above is the only thing that had to change.
///
/// A cancelled search returns `Err(SEARCH_CANCELLED)` and never stores
/// anything: the token is checked once more just before the cache is
/// written, never after, so a search either stores complete matches and
/// answers, or is cancelled and leaves the cache untouched.
fn search_messages_blocking(
    claude_path: String,
    query: String,
    filters: serde_json::Value,
    limit: Option<usize>,
    cancel: Option<&SearchCancelToken>,
) -> Result<Vec<ClaudeMessage>, String> {
    #[cfg(debug_assertions)]
    let start_time = std::time::Instant::now();

    ensure_search_active(cancel)?;
    let max_results = limit.unwrap_or(DEFAULT_SEARCH_LIMIT);
    validate_search_filters(&filters)?;

    // Empty is the default root, never a path relative to the working
    // directory (#693).
    let Some(claude_base) = crate::providers::claude::base_path_or_default(&claude_path) else {
        return Ok(vec![]);
    };
    let projects_path = claude_base.join("projects");
    if !projects_path.exists() {
        return Ok(vec![]);
    }

    // Regular files only, no symlink followed (`session_files`): a linked
    // `*.jsonl` entry would be read wherever it points, and a FIFO named
    // like a session would block the search.
    #[cfg(debug_assertions)]
    let walk_start = std::time::Instant::now();
    let file_paths: Vec<PathBuf> = session_files::regular_session_files(&projects_path);
    #[cfg(debug_assertions)]
    let walk_ms = walk_start.elapsed().as_millis();
    ensure_search_active(cancel)?;

    #[cfg(debug_assertions)]
    let cache_load_start = std::time::Instant::now();
    let key = cache_key(&claude_path, &query);
    let cached_files: HashMap<PathBuf, FileMatches> = SEARCH_CACHE
        .lock()
        .ok()
        .and_then(|mut cache| cache.get(&key).map(|entry| entry.files.clone()))
        .unwrap_or_default();
    #[cfg(debug_assertions)]
    let cache_load_ms = cache_load_start.elapsed().as_millis();
    ensure_search_active(cancel)?;

    // Per-file resolution: reuse cached matches when the file's (size, mtime)
    // signature is unchanged; anything else (changed, new, or unstat-able)
    // is re-scanned. Files missing from the current walk drop out because the
    // stored map is rebuilt from `file_paths` below. Stat'ing every file is a
    // fixed cost even when everything is cached, so a stale search stops here
    // too (`None` short-circuits the collect).
    #[cfg(debug_assertions)]
    let signature_start = std::time::Instant::now();
    let per_file: Option<Vec<FileSlot>> = file_paths
        .iter()
        .enumerate()
        .map(|(idx, path)| {
            if idx % CANCEL_CHECK_INTERVAL == 0 {
                #[cfg(test)]
                run_cancel_check_hook(&projects_path, idx);
                if is_cancelled(cancel) {
                    return None;
                }
            }
            let signature = FileSignature::of(path);
            let cached = signature.and_then(|sig| {
                cached_files
                    .get(path)
                    .and_then(|entry| (entry.signature == sig).then(|| Arc::clone(&entry.matches)))
            });
            Some((signature, cached))
        })
        .collect();
    let Some(mut per_file) = per_file else {
        return Err(SEARCH_CANCELLED.to_string());
    };
    #[cfg(debug_assertions)]
    let signature_ms = signature_start.elapsed().as_millis();

    // Uncached files the filters rule out are not read: their slot stays
    // empty, so they add nothing to the result and nothing to the cache.
    let prefilter = ScanPrefilter::new(&projects_path, &filters);
    let scan_indices: Vec<usize> = per_file
        .iter()
        .enumerate()
        .filter(|(_, (_, cached))| cached.is_none())
        .filter(|(idx, (signature, _))| !prefilter.excludes(&file_paths[*idx], *signature))
        .map(|(idx, _)| idx)
        .collect();
    // Counted only where it is logged, so no build keeps an unused counter.
    #[cfg(debug_assertions)]
    let prefiltered = per_file
        .iter()
        .filter(|(_, cached)| cached.is_none())
        .count()
        - scan_indices.len();

    #[cfg(debug_assertions)]
    eprintln!(
        "🔍 search_messages: {} files ({} cached, {} skipped by pre-filter, {} scanned)",
        file_paths.len(),
        file_paths.len() - scan_indices.len() - prefiltered,
        prefiltered,
        scan_indices.len()
    );

    let matcher = build_matcher(&query);

    // `None` from any file means the search went stale: the whole scan
    // short-circuits and nothing below (in particular the cache) is reached.
    #[cfg(debug_assertions)]
    let scan_start = std::time::Instant::now();
    let scanned: Option<Vec<(usize, Arc<Vec<ClaudeMessage>>)>> = scan_indices
        .into_par_iter()
        .map(|idx| {
            if is_cancelled(cancel) {
                return None;
            }
            #[cfg(test)]
            note_scan(&file_paths[idx]);
            let fallback_timestamp = per_file[idx].0.and_then(|signature| signature.mtime);
            search_in_file(
                &projects_path,
                &file_paths[idx],
                &matcher,
                fallback_timestamp,
                cancel,
            )
            .map(|matches| (idx, Arc::new(matches)))
        })
        .collect();
    let Some(scanned) = scanned else {
        return Err(SEARCH_CANCELLED.to_string());
    };
    for (idx, matches) in scanned {
        per_file[idx].1 = Some(matches);
    }
    #[cfg(debug_assertions)]
    let scan_ms = scan_start.elapsed().as_millis();

    // Merge in walk order — identical concatenation order to a cold scan, so
    // the selection below sees the same input either way.
    #[cfg(debug_assertions)]
    let filter_start = std::time::Instant::now();
    let raw: Vec<ClaudeMessage> = per_file
        .iter()
        .filter_map(|(_, matches)| matches.as_deref())
        .flat_map(|matches| matches.iter().cloned())
        .collect();

    let total_matches = raw.len();
    let mut filtered = apply_search_filters(raw, &filters);

    if filtered.len() > max_results {
        filtered.select_nth_unstable_by(max_results, |a, b| b.timestamp.cmp(&a.timestamp));
        filtered.truncate(max_results);
    }
    filtered.sort_unstable_by(|a, b| b.timestamp.cmp(&a.timestamp));
    #[cfg(debug_assertions)]
    let filter_ms = filter_start.elapsed().as_millis();

    // Last check, and the only one after the scan: from here on the search
    // stores its (complete) matches and answers.
    ensure_search_active(cancel)?;

    // Store the rebuilt per-file map; files whose signature could not be
    // captured are computed without caching (re-scanned next call). A file
    // the pre-filter did not read keeps the matches the entry holds now when
    // they are still valid for its signature: another search of the same
    // query may have stored them while this one ran, and dropping them would
    // make the next wider search read the file again.
    #[cfg(debug_assertions)]
    let store_start = std::time::Instant::now();
    if total_matches <= MAX_CACHED_MATCHES_PER_QUERY {
        if let Ok(mut cache) = SEARCH_CACHE.lock() {
            let current = cache.peek(&key).map(|entry| &entry.files);
            let mut stored_matches = total_matches;
            let mut files: HashMap<PathBuf, FileMatches> = HashMap::with_capacity(file_paths.len());
            for (path, (signature, matches)) in file_paths.into_iter().zip(per_file) {
                let Some(signature) = signature else {
                    continue;
                };
                if let Some(matches) = matches {
                    files.insert(path, FileMatches { signature, matches });
                    continue;
                }
                let Some(kept) = current
                    .and_then(|current| current.get(&path))
                    .filter(|kept| kept.signature == signature)
                else {
                    continue;
                };
                if stored_matches + kept.matches.len() > MAX_CACHED_MATCHES_PER_QUERY {
                    continue;
                }
                stored_matches += kept.matches.len();
                let matches = Arc::clone(&kept.matches);
                files.insert(path, FileMatches { signature, matches });
            }
            cache.put(key, CachedQuerySearch { files });
        }
    }
    #[cfg(debug_assertions)]
    let store_ms = store_start.elapsed().as_millis();

    #[cfg(debug_assertions)]
    {
        let elapsed = start_time.elapsed();
        eprintln!(
            "📊 search_messages performance: {} results (limit: {}), {}ms elapsed \
             (walk {}ms, cache load {}ms, signatures {}ms, scan {}ms, filter {}ms, \
             cache store {}ms; {} files not read by the pre-filter)",
            filtered.len(),
            max_results,
            elapsed.as_millis(),
            walk_ms,
            cache_load_ms,
            signature_ms,
            scan_ms,
            filter_ms,
            store_ms,
            prefiltered
        );
    }

    Ok(filtered)
}

/// Number of `search_in_file` scans recorded for `path`. Test-only cache-hit
/// observability, mirroring `stats::cache::test_build_count`.
#[cfg(test)]
fn note_scan(path: &std::path::Path) {
    if let Ok(mut counts) = scan_counts().lock() {
        *counts.entry(path.to_path_buf()).or_insert(0) += 1;
    }
}

#[cfg(test)]
fn test_scan_count(path: &std::path::Path) -> u64 {
    scan_counts()
        .lock()
        .map(|counts| counts.get(path).copied().unwrap_or(0))
        .unwrap_or(0)
}

#[cfg(test)]
fn scan_counts() -> &'static Mutex<std::collections::HashMap<PathBuf, u64>> {
    static SCAN_COUNTS: std::sync::OnceLock<Mutex<std::collections::HashMap<PathBuf, u64>>> =
        std::sync::OnceLock::new();
    SCAN_COUNTS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Drop every cached entry so the next search is a cold scan (test-only).
#[cfg(test)]
fn clear_search_cache_for_test() {
    if let Ok(mut cache) = SEARCH_CACHE.lock() {
        cache.clear();
    }
}

/// Test-only callback run at every cancel check inside `search_in_file`
/// (lines 0, `CANCEL_CHECK_INTERVAL`, …), so a test can cancel at an exact
/// point of a scan instead of racing it with sleeps.
#[cfg(test)]
type CancelCheckHook = Arc<dyn Fn(usize) + Send + Sync>;

#[cfg(test)]
fn cancel_check_hooks() -> &'static Mutex<HashMap<PathBuf, CancelCheckHook>> {
    static HOOKS: std::sync::OnceLock<Mutex<HashMap<PathBuf, CancelCheckHook>>> =
        std::sync::OnceLock::new();
    HOOKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(test)]
fn set_cancel_check_hook(path: &Path, hook: impl Fn(usize) + Send + Sync + 'static) {
    cancel_check_hooks()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(path.to_path_buf(), Arc::new(hook));
}

#[cfg(test)]
fn clear_cancel_check_hook(path: &Path) {
    cancel_check_hooks()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(path);
}

#[cfg(test)]
fn run_cancel_check_hook(path: &Path, line: usize) {
    // Clone out of the lock: the hook may cancel, which takes other locks.
    let hook = cancel_check_hooks()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(path)
        .cloned();
    if let Some(hook) = hook {
        hook(line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use std::sync::atomic::AtomicBool;
    use tempfile::TempDir;

    /// `extract_project_name` of the file at `relative` under a `projects/`
    /// root.
    fn name_under_projects(relative: &str) -> Option<String> {
        let root = PathBuf::from("/home/u/.claude/projects");
        extract_project_name(&root, &root.join(relative))
    }

    #[test]
    fn test_extract_project_name_uses_the_project_directory() {
        // Sessions, subagent transcripts, and workflow transcripts with their
        // journal: the project is the directory directly under `projects/`.
        for relative in [
            "-work-proj/abc.jsonl",
            "-work-proj/abc/subagents/agent-1.jsonl",
            "-work-proj/abc/subagents/workflows/wf_run1/agent-1.jsonl",
            "-work-proj/abc/subagents/workflows/wf_run1/journal.jsonl",
        ] {
            assert_eq!(
                name_under_projects(relative).as_deref(),
                Some("-work-proj"),
                "{relative}"
            );
        }
    }

    #[test]
    fn test_extract_project_name_goes_by_position_not_by_directory_name() {
        // A project may itself be called `subagents`.
        assert_eq!(
            name_under_projects("subagents/abc.jsonl").as_deref(),
            Some("subagents")
        );
        // The archive-compatible layout, without a session directory.
        assert_eq!(
            name_under_projects("-work-proj/subagents/abc/x.jsonl").as_deref(),
            Some("-work-proj")
        );
    }

    #[test]
    fn test_extract_project_name_ignores_directories_below_the_project() {
        assert_eq!(
            name_under_projects("-work-proj/subagents-notes/x.jsonl").as_deref(),
            Some("-work-proj")
        );
    }

    #[test]
    fn test_extract_project_name_gives_no_project_to_a_file_directly_in_projects() {
        assert_eq!(name_under_projects("x.jsonl"), None);
    }

    #[test]
    fn test_extract_project_name_falls_back_to_the_parent_directory_outside_the_root() {
        let root = PathBuf::from("/home/u/.claude/projects");
        for (path, expected) in [
            ("/elsewhere/-work-proj/abc.jsonl", "-work-proj"),
            (
                "/elsewhere/-work-proj/abc/subagents/agent-1.jsonl",
                "-work-proj",
            ),
            (
                "/elsewhere/-work-proj/subagents-notes/x.jsonl",
                "subagents-notes",
            ),
        ] {
            assert_eq!(
                extract_project_name(&root, Path::new(path)).as_deref(),
                Some(expected),
                "{path}"
            );
        }
    }

    // Both use a workflow path: the parent-directory fallback would name it
    // after the run directory, so only a matching root yields the project.
    #[test]
    fn test_extract_project_name_under_a_relative_root() {
        let root = Path::new(".claude/projects");
        let file = root.join("-work-proj/abc/subagents/workflows/wf_run1/agent-1.jsonl");
        assert_eq!(
            extract_project_name(root, &file).as_deref(),
            Some("-work-proj")
        );
    }

    /// A WSL distro is searched through a UNC root.
    #[cfg(windows)]
    #[test]
    fn test_extract_project_name_under_a_unc_root() {
        let root = Path::new(r"\\wsl.localhost\Ubuntu\home\u\.claude").join("projects");
        let file = root.join(r"-work-proj\abc\subagents\workflows\wf_run1\agent-1.jsonl");
        assert_eq!(
            extract_project_name(&root, &file).as_deref(),
            Some("-work-proj")
        );
    }

    #[tokio::test]
    async fn test_search_labels_subagent_hits_with_their_project() {
        let temp_dir = TempDir::new().unwrap();
        let projects_dir = temp_dir.path().join("projects");
        let subagents_dir = projects_dir
            .join("-work-proj")
            .join("sess-1")
            .join("subagents");
        fs::create_dir_all(&subagents_dir).unwrap();
        let mut file = File::create(subagents_dir.join("agent-1.jsonl")).unwrap();
        writeln!(
            file,
            "{}",
            create_sample_user_message("u1", "sess-1", "subagent_unique_needle")
        )
        .unwrap();

        let results = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "subagent_unique_needle".to_string(),
            serde_json::json!({ "projects": ["-work-proj"] }),
            Some(10),
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            results.len(),
            1,
            "the project filter must reach subagent hits"
        );
        assert_eq!(results[0].project_name.as_deref(), Some("-work-proj"));
    }

    fn create_sample_user_message(uuid: &str, session_id: &str, content: &str) -> String {
        format!(
            r#"{{"uuid":"{uuid}","sessionId":"{session_id}","timestamp":"2025-06-26T10:00:00Z","type":"user","message":{{"role":"user","content":"{content}"}}}}"#
        )
    }

    fn create_sample_assistant_message(uuid: &str, session_id: &str, content: &str) -> String {
        format!(
            r#"{{"uuid":"{uuid}","sessionId":"{session_id}","timestamp":"2025-06-26T10:01:00Z","type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"{content}"}}],"id":"msg_123","model":"claude-opus-4-20250514","usage":{{"input_tokens":100,"output_tokens":50}}}}}}"#
        )
    }

    /// A user/tool-result message whose `message.content` text is `visible`, while
    /// `result_stdout` lives only in the top-level `toolUseResult` field (mirrors
    /// how Read/Bash results are stored on disk).
    fn create_tool_result_message(
        uuid: &str,
        session_id: &str,
        visible: &str,
        result_stdout: &str,
    ) -> String {
        format!(
            r#"{{"uuid":"{uuid}","sessionId":"{session_id}","timestamp":"2025-06-26T10:02:00Z","type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_1","content":"{visible}"}}]}},"toolUseResult":{{"stdout":"{result_stdout}","stderr":"","interrupted":false}}}}"#
        )
    }

    #[tokio::test]
    async fn test_search_messages_basic() {
        let temp_dir = TempDir::new().unwrap();
        let projects_dir = temp_dir.path().join("projects");
        let project_dir = projects_dir.join("test-project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let content = format!(
            "{}\n{}\n",
            create_sample_user_message("uuid-1", "session-1", "Hello Rust programming"),
            create_sample_assistant_message("uuid-2", "session-1", "Rust is great!")
        );

        // Create file directly in project dir
        let file_path = project_dir.join("test.jsonl");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(content.as_bytes()).unwrap();

        let result = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "Rust".to_string(),
            serde_json::json!({}),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let messages = result.unwrap();
        assert_eq!(messages.len(), 2); // Both messages contain "Rust"
    }

    #[tokio::test]
    async fn test_search_messages_matches_tool_use_result() {
        // Regression for #394: a query that appears ONLY in toolUseResult
        // (e.g. command output / file contents) must be found by global search,
        // mirroring the in-session FlexSearch index.
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().join("projects").join("test-project");
        std::fs::create_dir_all(&project_dir).unwrap();

        // The unique token only appears in toolUseResult.stdout, never in content.
        let content = format!(
            "{}\n",
            create_tool_result_message(
                "uuid-1",
                "session-1",
                "command output below",
                "ZmagicMarker99"
            )
        );
        let file_path = project_dir.join("test.jsonl");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(content.as_bytes()).unwrap();

        let result = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "ZmagicMarker99".to_string(),
            serde_json::json!({}),
            None,
            None,
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            result.len(),
            1,
            "global search must match text found only in toolUseResult (#394)"
        );
    }

    #[tokio::test]
    async fn test_search_messages_case_insensitive() {
        let temp_dir = TempDir::new().unwrap();
        let projects_dir = temp_dir.path().join("projects");
        let project_dir = projects_dir.join("test-project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let content = format!(
            "{}\n",
            create_sample_user_message("uuid-1", "session-1", "HELLO World")
        );

        let file_path = project_dir.join("test.jsonl");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(content.as_bytes()).unwrap();

        let result = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "hello".to_string(), // lowercase
            serde_json::json!({}),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        let messages = result.unwrap();
        assert_eq!(messages.len(), 1);
    }

    #[tokio::test]
    async fn test_search_messages_no_results() {
        let temp_dir = TempDir::new().unwrap();
        let projects_dir = temp_dir.path().join("projects");
        let project_dir = projects_dir.join("test-project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let content = format!(
            "{}\n",
            create_sample_user_message("uuid-1", "session-1", "Hello World")
        );

        let file_path = project_dir.join("test.jsonl");
        let mut file = File::create(&file_path).unwrap();
        file.write_all(content.as_bytes()).unwrap();

        let result = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "nonexistent".to_string(),
            serde_json::json!({}),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_messages_empty_projects_dir() {
        let temp_dir = TempDir::new().unwrap();
        // Don't create projects directory

        let result = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "test".to_string(),
            serde_json::json!({}),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_ok());
        assert!(result.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_search_messages_invalid_date_filter_returns_error() {
        let temp_dir = TempDir::new().unwrap();

        let result = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "test".to_string(),
            serde_json::json!({
                "dateRange": ["invalid-date", "2026-02-20T00:00:00Z"]
            }),
            None,
            None,
            None,
        )
        .await;

        assert!(result.is_err());
        assert!(result
            .err()
            .unwrap_or_default()
            .contains("Invalid dateRange start"));
    }

    /// Two-file fixture: both files match `query_marker`, each with one
    /// message. Returns (`temp_dir`, `file_a`, `file_b`).
    fn two_file_fixture(query_marker: &str) -> (TempDir, PathBuf, PathBuf) {
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().join("projects").join("test-project");
        std::fs::create_dir_all(&project_dir).unwrap();

        let file_a = project_dir.join("session-a.jsonl");
        let mut writer = File::create(&file_a).unwrap();
        writeln!(
            writer,
            "{}",
            create_sample_user_message("uuid-a1", "session-a", &format!("{query_marker} in a"))
        )
        .unwrap();

        let file_b = project_dir.join("session-b.jsonl");
        let mut writer = File::create(&file_b).unwrap();
        writeln!(
            writer,
            "{}",
            create_sample_user_message("uuid-b1", "session-b", &format!("{query_marker} in b"))
        )
        .unwrap();

        (temp_dir, file_a, file_b)
    }

    async fn run_search(temp_dir: &TempDir, query: &str) -> Vec<ClaudeMessage> {
        search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            query.to_string(),
            serde_json::json!({}),
            None,
            None,
            None,
        )
        .await
        .expect("search must succeed")
    }

    fn uuids(messages: &[ClaudeMessage]) -> Vec<&str> {
        let mut out: Vec<&str> = messages.iter().map(|m| m.uuid.as_str()).collect();
        out.sort_unstable();
        out
    }

    #[tokio::test]
    /// Core invalidation behavior: an unchanged file is served from cache
    /// (no re-scan), an appended file is re-scanned, and the merged result
    /// after the append equals a cold scan.
    async fn test_search_cache_rescans_only_appended_file() {
        let (temp_dir, file_a, file_b) = two_file_fixture("cacheProbe42");

        let first = run_search(&temp_dir, "cacheProbe42").await;
        assert_eq!(uuids(&first), ["uuid-a1", "uuid-b1"]);
        assert_eq!(test_scan_count(&file_a), 1);
        assert_eq!(test_scan_count(&file_b), 1);

        // Unchanged corpus: served entirely from cache.
        let second = run_search(&temp_dir, "cacheProbe42").await;
        assert_eq!(uuids(&second), ["uuid-a1", "uuid-b1"]);
        assert_eq!(
            test_scan_count(&file_a),
            1,
            "unchanged file a must not re-scan"
        );
        assert_eq!(
            test_scan_count(&file_b),
            1,
            "unchanged file b must not re-scan"
        );

        // Append a matching message to file a only.
        let mut appender = std::fs::OpenOptions::new()
            .append(true)
            .open(&file_a)
            .unwrap();
        writeln!(
            appender,
            "{}",
            create_sample_user_message("uuid-a2", "session-a", "cacheProbe42 appended")
        )
        .unwrap();
        drop(appender);

        let third = run_search(&temp_dir, "cacheProbe42").await;
        assert_eq!(
            uuids(&third),
            ["uuid-a1", "uuid-a2", "uuid-b1"],
            "results must reflect a's new content and keep b's cached contribution"
        );
        assert_eq!(test_scan_count(&file_a), 2, "appended file a must re-scan");
        assert_eq!(
            test_scan_count(&file_b),
            1,
            "a change to file a must not evict file b's cached matches"
        );

        // Warm result must equal a cold scan of the same corpus.
        clear_search_cache_for_test();
        let cold = run_search(&temp_dir, "cacheProbe42").await;
        assert_eq!(
            serde_json::to_value(&third).unwrap(),
            serde_json::to_value(&cold).unwrap(),
            "warm search must equal a cold scan"
        );
    }

    #[tokio::test]
    /// A change to an unrelated file evicts nothing: only the changed file
    /// is re-scanned, even when it never matched the query.
    async fn test_search_unrelated_file_change_does_not_evict() {
        let (temp_dir, file_a, file_b) = two_file_fixture("evictProbe7");

        // Third file that does NOT match the query.
        let file_c = file_a.parent().unwrap().join("session-c.jsonl");
        let mut writer = File::create(&file_c).unwrap();
        writeln!(
            writer,
            "{}",
            create_sample_user_message("uuid-c1", "session-c", "nothing to see")
        )
        .unwrap();
        drop(writer);

        let first = run_search(&temp_dir, "evictProbe7").await;
        assert_eq!(uuids(&first), ["uuid-a1", "uuid-b1"]);
        assert_eq!(test_scan_count(&file_a), 1);
        assert_eq!(test_scan_count(&file_b), 1);
        assert_eq!(test_scan_count(&file_c), 1);

        // Append to the unrelated file only.
        let mut appender = std::fs::OpenOptions::new()
            .append(true)
            .open(&file_c)
            .unwrap();
        writeln!(
            appender,
            "{}",
            create_sample_user_message("uuid-c2", "session-c", "still unrelated")
        )
        .unwrap();
        drop(appender);

        let second = run_search(&temp_dir, "evictProbe7").await;
        assert_eq!(uuids(&second), ["uuid-a1", "uuid-b1"]);
        assert_eq!(
            test_scan_count(&file_a),
            1,
            "unrelated change must not re-scan file a"
        );
        assert_eq!(
            test_scan_count(&file_b),
            1,
            "unrelated change must not re-scan file b"
        );
        assert_eq!(test_scan_count(&file_c), 2, "changed file c must re-scan");
    }

    #[tokio::test]
    /// A temp+rename rewrite can keep the same (size, mtime) signature —
    /// explicit eviction must force a re-scan of that file only.
    async fn test_evict_file_forces_rescan_without_signature_change() {
        let (temp_dir, file_a, file_b) = two_file_fixture("evictExplicit3");

        let first = run_search(&temp_dir, "evictExplicit3").await;
        assert_eq!(uuids(&first), ["uuid-a1", "uuid-b1"]);
        assert_eq!(test_scan_count(&file_a), 1);
        assert_eq!(test_scan_count(&file_b), 1);

        // No file change at all — eviction alone must invalidate file a.
        evict_file_from_search_cache(&file_a);

        let second = run_search(&temp_dir, "evictExplicit3").await;
        assert_eq!(uuids(&second), ["uuid-a1", "uuid-b1"]);
        assert_eq!(test_scan_count(&file_a), 2, "evicted file must re-scan");
        assert_eq!(test_scan_count(&file_b), 1, "other files must stay cached");
    }

    #[tokio::test]
    /// Filters and limit are applied at serve time over cached raw matches:
    /// changing them must not trigger any re-scan.
    async fn test_search_filter_and_limit_changes_reuse_cached_matches() {
        let (temp_dir, file_a, file_b) = two_file_fixture("filterProbe9");

        let unfiltered = run_search(&temp_dir, "filterProbe9").await;
        assert_eq!(uuids(&unfiltered), ["uuid-a1", "uuid-b1"]);
        assert_eq!(test_scan_count(&file_a), 1);
        assert_eq!(test_scan_count(&file_b), 1);

        // Same query with a filter and a limit: served from cached matches.
        let limited = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "filterProbe9".to_string(),
            serde_json::json!({ "messageType": "user" }),
            Some(1),
            None,
            None,
        )
        .await
        .expect("filtered search must succeed");
        assert_eq!(limited.len(), 1);
        assert_eq!(
            test_scan_count(&file_a),
            1,
            "filter/limit change must not re-scan file a"
        );
        assert_eq!(
            test_scan_count(&file_b),
            1,
            "filter/limit change must not re-scan file b"
        );

        // Cold-scan equivalence for the filtered call.
        clear_search_cache_for_test();
        let cold = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "filterProbe9".to_string(),
            serde_json::json!({ "messageType": "user" }),
            Some(1),
            None,
            None,
        )
        .await
        .expect("cold filtered search must succeed");
        assert_eq!(
            serde_json::to_value(&limited).unwrap(),
            serde_json::to_value(&cold).unwrap()
        );
    }

    #[tokio::test]
    /// Deleted files drop out of the merged result and new files are picked
    /// up, while untouched files stay cached.
    async fn test_search_detects_deleted_and_new_files() {
        let (temp_dir, file_a, file_b) = two_file_fixture("lifecycleProbe3");

        let first = run_search(&temp_dir, "lifecycleProbe3").await;
        assert_eq!(uuids(&first), ["uuid-a1", "uuid-b1"]);

        std::fs::remove_file(&file_b).unwrap();
        let file_c = file_a.parent().unwrap().join("session-c.jsonl");
        let mut writer = File::create(&file_c).unwrap();
        writeln!(
            writer,
            "{}",
            create_sample_user_message("uuid-c1", "session-c", "lifecycleProbe3 in c")
        )
        .unwrap();
        drop(writer);

        let second = run_search(&temp_dir, "lifecycleProbe3").await;
        assert_eq!(
            uuids(&second),
            ["uuid-a1", "uuid-c1"],
            "deleted file b must drop out; new file c must be picked up"
        );
        assert_eq!(test_scan_count(&file_a), 1, "untouched file a stays cached");
        assert_eq!(test_scan_count(&file_c), 1);
    }

    /// A session file linked into the history root from elsewhere is never
    /// searched; only the files that are there are (#696 review).
    #[cfg(unix)]
    #[tokio::test]
    async fn test_search_never_reads_a_session_file_through_a_symlink() {
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().join("projects").join("p");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("inside.jsonl"),
            create_sample_user_message("uuid-in", "inside", "needle inside") + "\n",
        )
        .unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("private.jsonl");
        std::fs::write(
            &outside_file,
            create_sample_user_message("uuid-out", "private", "needle outside") + "\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside_file, project_dir.join("escaped.jsonl")).unwrap();

        let messages = search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            "needle".to_string(),
            serde_json::json!({}),
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let sessions: Vec<&str> = messages.iter().map(|m| m.session_id.as_str()).collect();
        assert_eq!(sessions, ["inside"]);
    }

    /// The root itself may be reached through a symlink (a symlinked
    /// `~/.claude` or `projects/`, #355): its files are still searched.
    #[cfg(unix)]
    #[tokio::test]
    async fn test_search_reads_a_root_reached_through_a_symlink() {
        let real = TempDir::new().unwrap();
        let real_projects = real.path().join("real-projects");
        let project_dir = real_projects.join("p");
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(
            project_dir.join("inside.jsonl"),
            create_sample_user_message("uuid-in", "inside", "needle inside") + "\n",
        )
        .unwrap();
        let base = TempDir::new().unwrap();
        std::os::unix::fs::symlink(&real_projects, base.path().join("projects")).unwrap();
        let linked_base = TempDir::new().unwrap();
        let linked = linked_base.path().join("claude");
        std::os::unix::fs::symlink(base.path(), &linked).unwrap();

        for claude_path in [base.path().to_path_buf(), linked] {
            let messages = search_messages(
                claude_path.to_string_lossy().to_string(),
                "needle".to_string(),
                serde_json::json!({}),
                None,
                None,
                None,
            )
            .await
            .unwrap();
            assert_eq!(messages.len(), 1, "{}", claude_path.display());
        }
    }

    // ─── 事前の絞り込み（読むファイルを先に絞る） ───────────────────────────

    /// A user message with an explicit timestamp, or none at all when `ts` is
    /// `None` (the scanner then falls back to the file's mtime).
    fn message_at(uuid: &str, session_id: &str, ts: Option<&str>, content: &str) -> String {
        let ts_field = ts
            .map(|ts| format!(r#""timestamp":"{ts}","#))
            .unwrap_or_default();
        format!(
            r#"{{"uuid":"{uuid}","sessionId":"{session_id}",{ts_field}"type":"user","message":{{"role":"user","content":"{content}"}}}}"#
        )
    }

    fn write_session(project_dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        std::fs::create_dir_all(project_dir).unwrap();
        let path = project_dir.join(name);
        let mut body = lines.join("\n");
        body.push('\n');
        std::fs::write(&path, body).unwrap();
        path
    }

    /// Pin a file's mtime. Windows needs a handle opened for writing.
    fn set_mtime(path: &Path, mtime: DateTime<Utc>) {
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::from(mtime)).unwrap();
    }

    async fn search_with(
        temp_dir: &TempDir,
        query: &str,
        filters: serde_json::Value,
        cancel: Option<(&str, u64)>,
    ) -> Result<Vec<ClaudeMessage>, String> {
        search_messages(
            temp_dir.path().to_string_lossy().to_string(),
            query.to_string(),
            filters,
            Some(1000),
            cancel.map(|(group, _)| group.to_string()),
            cancel.map(|(_, seq)| seq),
        )
        .await
    }

    fn date_range(start: DateTime<Utc>, end: DateTime<Utc>) -> serde_json::Value {
        serde_json::json!({ "dateRange": [start.to_rfc3339(), end.to_rfc3339()] })
    }

    #[tokio::test]
    async fn test_prefilter_never_reads_files_outside_the_selected_projects() {
        let temp_dir = TempDir::new().unwrap();
        let projects = temp_dir.path().join("projects");
        let wanted = write_session(
            &projects.join("p-wanted"),
            "s1.jsonl",
            &[create_sample_user_message("w1", "s1", "projProbe1 here")],
        );
        let other = write_session(
            &projects.join("p-other"),
            "s2.jsonl",
            &[create_sample_user_message("o1", "s2", "projProbe1 there")],
        );

        let results = search_with(
            &temp_dir,
            "projProbe1",
            serde_json::json!({ "projects": ["p-wanted"] }),
            None,
        )
        .await
        .unwrap();

        assert_eq!(uuids(&results), ["w1"]);
        assert_eq!(test_scan_count(&wanted), 1);
        assert_eq!(
            test_scan_count(&other),
            0,
            "a file outside the selected projects must not be read"
        );
    }

    #[tokio::test]
    async fn test_prefilter_never_reads_files_last_written_before_the_date_range() {
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().join("projects").join("p");
        let now = Utc::now();
        let old_ts = now - chrono::Duration::days(30);
        let old = write_session(
            &project_dir,
            "old.jsonl",
            &[message_at(
                "old1",
                "old",
                Some(&old_ts.to_rfc3339()),
                "dateProbe2 old",
            )],
        );
        set_mtime(&old, old_ts);
        let fresh = write_session(
            &project_dir,
            "fresh.jsonl",
            &[message_at(
                "new1",
                "fresh",
                Some(&now.to_rfc3339()),
                "dateProbe2 new",
            )],
        );

        let results = search_with(
            &temp_dir,
            "dateProbe2",
            date_range(
                now - chrono::Duration::days(2),
                now + chrono::Duration::days(1),
            ),
            None,
        )
        .await
        .unwrap();

        assert_eq!(uuids(&results), ["new1"]);
        assert_eq!(test_scan_count(&fresh), 1);
        assert_eq!(
            test_scan_count(&old),
            0,
            "a file last written before the range must not be read"
        );
    }

    /// Cold search with a range and a project filter returns exactly what an
    /// unfiltered search followed by the same filtered search returns —
    /// including rows without a timestamp, which take the file's mtime.
    #[tokio::test]
    async fn test_prefilter_matches_the_unfiltered_then_filtered_result() {
        let temp_dir = TempDir::new().unwrap();
        let projects = temp_dir.path().join("projects");
        let now = Utc::now();
        let old_ts = now - chrono::Duration::days(30);
        let recent_ts = now - chrono::Duration::hours(1);

        let old = write_session(
            &projects.join("p1"),
            "old.jsonl",
            &[
                message_at("old-ts", "old", Some(&old_ts.to_rfc3339()), "eqProbe3 a"),
                message_at("old-nots", "old", None, "eqProbe3 b"),
            ],
        );
        set_mtime(&old, old_ts);
        write_session(
            &projects.join("p1"),
            "fresh.jsonl",
            &[
                message_at(
                    "p1-ts",
                    "fresh",
                    Some(&recent_ts.to_rfc3339()),
                    "eqProbe3 c",
                ),
                message_at("p1-nots", "fresh", None, "eqProbe3 d"),
                message_at(
                    "p1-oldmsg",
                    "fresh",
                    Some(&old_ts.to_rfc3339()),
                    "eqProbe3 e",
                ),
            ],
        );
        write_session(
            &projects.join("p2"),
            "other.jsonl",
            &[message_at(
                "p2-ts",
                "other",
                Some(&recent_ts.to_rfc3339()),
                "eqProbe3 f",
            )],
        );

        let mut filters = date_range(
            now - chrono::Duration::days(2),
            now + chrono::Duration::days(1),
        );
        filters["projects"] = serde_json::json!(["p1"]);

        let cold = search_with(&temp_dir, "eqProbe3", filters.clone(), None)
            .await
            .unwrap();
        assert_eq!(uuids(&cold), ["p1-nots", "p1-ts"]);

        clear_search_cache_for_test();
        let unfiltered = search_with(&temp_dir, "eqProbe3", serde_json::json!({}), None)
            .await
            .unwrap();
        assert_eq!(unfiltered.len(), 6);
        let warm = search_with(&temp_dir, "eqProbe3", filters, None)
            .await
            .unwrap();

        assert_eq!(
            serde_json::to_value(&cold).unwrap(),
            serde_json::to_value(&warm).unwrap(),
            "the pre-filtered cold search must equal the filtered warm search"
        );
    }

    #[tokio::test]
    async fn test_prefilter_uses_remembered_matches_and_reads_skipped_files_later() {
        let temp_dir = TempDir::new().unwrap();
        let projects = temp_dir.path().join("projects");
        let a = write_session(
            &projects.join("pa"),
            "a.jsonl",
            &[create_sample_user_message("a1", "a", "memProbe4 a")],
        );
        let b = write_session(
            &projects.join("pb"),
            "b.jsonl",
            &[create_sample_user_message("b1", "b", "memProbe4 b")],
        );
        let only_a = serde_json::json!({ "projects": ["pa"] });

        // Cold and narrowed: b is skipped and stays unread.
        let narrowed = search_with(&temp_dir, "memProbe4", only_a.clone(), None)
            .await
            .unwrap();
        assert_eq!(uuids(&narrowed), ["a1"]);
        assert_eq!((test_scan_count(&a), test_scan_count(&b)), (1, 0));

        // An unfiltered search reads the skipped file, and only it.
        let all = search_with(&temp_dir, "memProbe4", serde_json::json!({}), None)
            .await
            .unwrap();
        assert_eq!(uuids(&all), ["a1", "b1"]);
        assert_eq!(
            (test_scan_count(&a), test_scan_count(&b)),
            (1, 1),
            "the skipped file is read later; the remembered one is not re-read"
        );

        // Remembered matches serve a narrowed search too, even for b.
        let only_b = search_with(
            &temp_dir,
            "memProbe4",
            serde_json::json!({ "projects": ["pb"] }),
            None,
        )
        .await
        .unwrap();
        assert_eq!(uuids(&only_b), ["b1"]);
        let again_a = search_with(&temp_dir, "memProbe4", only_a, None)
            .await
            .unwrap();
        assert_eq!(uuids(&again_a), ["a1"]);
        assert_eq!((test_scan_count(&a), test_scan_count(&b)), (1, 1));
    }

    /// A file written exactly one hour before the range start is still read;
    /// one written a second earlier is not.
    #[tokio::test]
    async fn test_prefilter_mtime_margin_is_one_hour() {
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().join("projects").join("p");
        let start = DateTime::parse_from_rfc3339("2026-01-10T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let edge = write_session(
            &project_dir,
            "edge.jsonl",
            &[create_sample_user_message("e1", "edge", "marginProbe5")],
        );
        set_mtime(&edge, start - chrono::Duration::hours(1));
        let past = write_session(
            &project_dir,
            "past.jsonl",
            &[create_sample_user_message("p1", "past", "marginProbe5")],
        );
        set_mtime(
            &past,
            start - chrono::Duration::hours(1) - chrono::Duration::seconds(1),
        );

        search_with(
            &temp_dir,
            "marginProbe5",
            date_range(start, start + chrono::Duration::days(1)),
            None,
        )
        .await
        .unwrap();

        assert_eq!(test_scan_count(&edge), 1, "exactly start - 1h is read");
        assert_eq!(
            test_scan_count(&past),
            0,
            "older than start - 1h is skipped"
        );
    }

    // ─── Project names below the project directory ──────────────────────────

    /// A workflow subagent transcript and its journal in `-work-proj`, and a
    /// plain session in `-other-proj`. Returns (`temp_dir`, `agent`,
    /// `journal`, `other`).
    fn workflow_fixture(query_marker: &str) -> (TempDir, PathBuf, PathBuf, PathBuf) {
        let temp_dir = TempDir::new().unwrap();
        let projects = temp_dir.path().join("projects");
        let run_dir = projects
            .join("-work-proj")
            .join("sess-1")
            .join("subagents")
            .join("workflows")
            .join("wf_run1");
        let agent = write_session(
            &run_dir,
            "agent-1.jsonl",
            &[create_sample_user_message(
                "wf1",
                "sess-1",
                &format!("{query_marker} in a workflow"),
            )],
        );
        // A journal row has no `message`, so it never matches.
        let journal = write_session(
            &run_dir,
            "journal.jsonl",
            &[format!(r#"{{"type":"started","key":"{query_marker}"}}"#)],
        );
        let other = write_session(
            &projects.join("-other-proj"),
            "s2.jsonl",
            &[create_sample_user_message(
                "o1",
                "s2",
                &format!("{query_marker} elsewhere"),
            )],
        );
        (temp_dir, agent, journal, other)
    }

    #[tokio::test]
    async fn test_search_labels_workflow_hits_with_their_project() {
        let (temp_dir, agent, journal, other) = workflow_fixture("wfProbe11");

        let results = search_with(
            &temp_dir,
            "wfProbe11",
            serde_json::json!({ "projects": ["-work-proj"] }),
            None,
        )
        .await
        .unwrap();

        assert_eq!(
            uuids(&results),
            ["wf1"],
            "the project filter must reach workflow hits"
        );
        assert_eq!(results[0].project_name.as_deref(), Some("-work-proj"));
        assert_eq!(
            (
                test_scan_count(&agent),
                test_scan_count(&journal),
                test_scan_count(&other)
            ),
            (1, 1, 0)
        );
    }

    #[tokio::test]
    async fn test_prefilter_never_reads_workflow_files_of_another_project() {
        let (temp_dir, agent, journal, other) = workflow_fixture("wfProbe12");

        // Cold, so a file with no scan was skipped, not served from memory.
        let results = search_with(
            &temp_dir,
            "wfProbe12",
            serde_json::json!({ "projects": ["-other-proj"] }),
            None,
        )
        .await
        .unwrap();

        assert_eq!(uuids(&results), ["o1"]);
        assert_eq!(
            (
                test_scan_count(&agent),
                test_scan_count(&journal),
                test_scan_count(&other)
            ),
            (0, 0, 1),
            "workflow files of an unselected project must not be read"
        );
    }

    /// A workflow run directory is not a project: selecting it reads nothing.
    #[tokio::test]
    async fn test_search_does_not_treat_a_workflow_run_directory_as_a_project() {
        let (temp_dir, agent, journal, other) = workflow_fixture("wfProbe13");

        let results = search_with(
            &temp_dir,
            "wfProbe13",
            serde_json::json!({ "projects": ["wf_run1"] }),
            None,
        )
        .await
        .unwrap();

        assert!(results.is_empty(), "got {:?}", uuids(&results));
        assert_eq!(
            (
                test_scan_count(&agent),
                test_scan_count(&journal),
                test_scan_count(&other)
            ),
            (0, 0, 0)
        );
    }

    #[tokio::test]
    async fn test_workflow_project_filter_is_the_same_cold_and_after_an_unfiltered_search() {
        let (temp_dir, agent, _journal, _other) = workflow_fixture("wfProbe14");
        let filters = serde_json::json!({ "projects": ["-work-proj"] });

        let cold = search_with(&temp_dir, "wfProbe14", filters.clone(), None)
            .await
            .unwrap();
        assert_eq!(uuids(&cold), ["wf1"]);

        clear_search_cache_for_test();
        let unfiltered = search_with(&temp_dir, "wfProbe14", serde_json::json!({}), None)
            .await
            .unwrap();
        assert_eq!(uuids(&unfiltered), ["o1", "wf1"]);
        let warm = search_with(&temp_dir, "wfProbe14", filters, None)
            .await
            .unwrap();

        assert_eq!(
            test_scan_count(&agent),
            2,
            "the last search is served from the remembered matches"
        );
        assert_eq!(
            serde_json::to_value(&cold).unwrap(),
            serde_json::to_value(&warm).unwrap(),
            "the pre-filtered cold search must equal the filtered warm search"
        );
    }

    /// The walk hands out paths that start with the root as it was passed in,
    /// so an unnormalized root names the same projects.
    #[tokio::test]
    async fn test_search_names_projects_under_an_unnormalized_root() {
        let (temp_dir, _agent, _journal, _other) = workflow_fixture("wfProbe15");
        let root = temp_dir.path().to_string_lossy().to_string();

        for claude_path in [format!("{root}/"), format!("{root}/./")] {
            let results = search_messages(
                claude_path.clone(),
                "wfProbe15".to_string(),
                serde_json::json!({ "projects": ["-work-proj"] }),
                Some(10),
                None,
                None,
            )
            .await
            .unwrap();

            assert_eq!(uuids(&results), ["wf1"], "{claude_path}");
            assert_eq!(results[0].project_name.as_deref(), Some("-work-proj"));
        }
    }

    /// A file lying directly in `projects/` is searched, but belongs to no
    /// project: no project selection (not even "projects") matches it.
    #[tokio::test]
    async fn test_search_file_directly_in_projects_belongs_to_no_project() {
        let temp_dir = TempDir::new().unwrap();
        let projects = temp_dir.path().join("projects");
        let loose = write_session(
            &projects,
            "loose.jsonl",
            &[create_sample_user_message("l1", "loose", "looseProbe16")],
        );
        let selected = serde_json::json!({ "projects": ["projects"] });

        let cold = search_with(&temp_dir, "looseProbe16", selected.clone(), None)
            .await
            .unwrap();
        assert!(cold.is_empty(), "got {:?}", uuids(&cold));
        assert_eq!(test_scan_count(&loose), 0);

        let unfiltered = search_with(&temp_dir, "looseProbe16", serde_json::json!({}), None)
            .await
            .unwrap();
        assert_eq!(uuids(&unfiltered), ["l1"]);
        assert_eq!(unfiltered[0].project_name, None);

        let warm = search_with(&temp_dir, "looseProbe16", selected, None)
            .await
            .unwrap();
        assert!(warm.is_empty(), "got {:?}", uuids(&warm));
        assert_eq!(test_scan_count(&loose), 1);
    }

    // ─── 古い検索の中断 ─────────────────────────────────────────────────────

    fn cached_entry_exists(temp_dir: &TempDir, query: &str) -> bool {
        let key = cache_key(&temp_dir.path().to_string_lossy(), query);
        SEARCH_CACHE
            .lock()
            .map(|cache| cache.peek(&key).is_some())
            .unwrap_or(false)
    }

    /// A search cancelled in the middle of a file returns the cancel error,
    /// stores nothing, and the next search reads the file again in full.
    #[tokio::test]
    async fn test_cancel_mid_file_returns_error_and_stores_nothing() {
        let temp_dir = TempDir::new().unwrap();
        let project_dir = temp_dir.path().join("projects").join("p");
        let lines: Vec<String> = (0..600)
            .map(|i| create_sample_user_message(&format!("m{i}"), "s", "cancelProbe6"))
            .collect();
        let file = write_session(&project_dir, "s.jsonl", &lines);

        let group = "test-cancel-mid-file";
        let checks = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&checks);
        set_cancel_check_hook(&file, move |line| {
            seen.lock().unwrap().push(line);
            if line >= CANCEL_CHECK_INTERVAL {
                cancel_search_group(group, 1);
            }
        });

        let result = search_with(
            &temp_dir,
            "cancelProbe6",
            serde_json::json!({}),
            Some((group, 1)),
        )
        .await;
        clear_cancel_check_hook(&file);

        assert_eq!(result.unwrap_err(), SEARCH_CANCELLED);
        assert_eq!(
            *checks.lock().unwrap(),
            [0, CANCEL_CHECK_INTERVAL],
            "the scan stops at the first check after the cancel, mid-file"
        );
        assert!(
            !cached_entry_exists(&temp_dir, "cancelProbe6"),
            "a cancelled search must store nothing"
        );

        let full = search_with(&temp_dir, "cancelProbe6", serde_json::json!({}), None)
            .await
            .unwrap();
        assert_eq!(full.len(), 600);
        assert_eq!(test_scan_count(&file), 2, "the file is read again in full");
        assert!(cached_entry_exists(&temp_dir, "cancelProbe6"));
    }

    /// A late cancel for an older search never stops a newer one.
    #[tokio::test]
    async fn test_late_cancel_for_an_older_seq_does_not_stop_a_newer_search() {
        let temp_dir = TempDir::new().unwrap();
        let file = write_session(
            &temp_dir.path().join("projects").join("p"),
            "s.jsonl",
            &[create_sample_user_message("u1", "s", "lateProbe7")],
        );
        let group = "test-late-cancel";
        set_cancel_check_hook(&file, move |_| cancel_search_group(group, 1));

        let result = search_with(
            &temp_dir,
            "lateProbe7",
            serde_json::json!({}),
            Some((group, 2)),
        )
        .await;
        clear_cancel_check_hook(&file);

        assert_eq!(uuids(&result.unwrap()), ["u1"]);
    }

    /// A cancel that arrives before its search stops it before any read.
    #[tokio::test]
    async fn test_cancel_that_arrives_first_stops_the_search_before_reading() {
        let temp_dir = TempDir::new().unwrap();
        let file = write_session(
            &temp_dir.path().join("projects").join("p"),
            "s.jsonl",
            &[create_sample_user_message("u1", "s", "earlyProbe8")],
        );
        let group = "test-early-cancel";
        cancel_search(group.to_string(), 2).await.unwrap();

        let result = search_with(
            &temp_dir,
            "earlyProbe8",
            serde_json::json!({}),
            Some((group, 2)),
        )
        .await;

        assert_eq!(result.unwrap_err(), SEARCH_CANCELLED);
        assert_eq!(test_scan_count(&file), 0, "nothing is read");
        assert!(!cached_entry_exists(&temp_dir, "earlyProbe8"));

        // A newer search in the same group runs.
        let newer = search_with(
            &temp_dir,
            "earlyProbe8",
            serde_json::json!({}),
            Some((group, 3)),
        )
        .await
        .unwrap();
        assert_eq!(uuids(&newer), ["u1"]);
    }

    /// Without both a group and a seq a search is never cancelled.
    #[tokio::test]
    async fn test_search_without_group_or_seq_is_never_cancelled() {
        let temp_dir = TempDir::new().unwrap();
        write_session(
            &temp_dir.path().join("projects").join("p"),
            "s.jsonl",
            &[create_sample_user_message("u1", "s", "noSeqProbe9")],
        );
        let group = "test-no-seq";
        cancel_search_group(group, 100);

        for (cancel_group, cancel_seq) in [
            (None, None),
            (Some(group.to_string()), None),
            (None, Some(1)),
        ] {
            let result = search_messages(
                temp_dir.path().to_string_lossy().to_string(),
                "noSeqProbe9".to_string(),
                serde_json::json!({}),
                None,
                cancel_group.clone(),
                cancel_seq,
            )
            .await;
            assert_eq!(
                uuids(&result.unwrap()),
                ["u1"],
                "group={cancel_group:?} seq={cancel_seq:?}"
            );
        }
    }

    #[test]
    fn test_cancel_token_follows_the_latest_seq_in_any_arrival_order() {
        let group = "test-token-order";
        let three = SearchCancelToken::begin(Some(group), Some(3)).unwrap();
        let two = SearchCancelToken::begin(Some(group), Some(2)).unwrap();
        assert!(
            two.is_cancelled(),
            "an older search arriving late starts cancelled"
        );
        assert!(!three.is_cancelled());

        cancel_search_group(group, 2);
        assert!(!three.is_cancelled(), "cancel(2) leaves seq 3 running");
        cancel_search_group(group, 3);
        assert!(three.is_cancelled(), "cancel(3) stops seq 3");

        let four = SearchCancelToken::begin(Some(group), Some(4)).unwrap();
        assert!(!four.is_cancelled());
        assert!(SearchCancelToken::begin(None, Some(4)).is_none());
        assert!(SearchCancelToken::begin(Some(group), None).is_none());
    }

    /// Evicting a group from the bounded table never cancels a running search
    /// nor panics.
    #[test]
    fn test_cancel_group_eviction_never_cancels_a_running_search() {
        let token = SearchCancelToken::begin(Some("test-evicted-group"), Some(1)).unwrap();
        for i in 0..(CANCEL_GROUP_CAPACITY + 10) {
            let filler = format!("test-evict-filler-{i}");
            let _ = SearchCancelToken::begin(Some(&filler), Some(5));
            cancel_search_group(&filler, 7);
        }
        assert!(!token.is_cancelled());
        assert!(ensure_search_active(Some(&token)).is_ok());
        let groups = CANCEL_GROUPS.lock().unwrap_or_else(PoisonError::into_inner);
        assert!(
            groups.len() <= CANCEL_GROUP_CAPACITY,
            "the group table is bounded"
        );
        assert!(
            groups.peek("test-evicted-group").is_none(),
            "the running search's group was really pushed out"
        );
    }

    /// A group name longer than `MAX_CANCEL_GROUP_LEN` never enters the table:
    /// the search runs uncancellable and `cancel_search` refuses it.
    #[tokio::test]
    async fn test_overlong_cancel_group_is_refused() {
        let longest = "g".repeat(MAX_CANCEL_GROUP_LEN);
        assert!(SearchCancelToken::begin(Some(&longest), Some(1)).is_some());
        assert!(cancel_search(longest, 1).await.is_ok());

        let overlong = "h".repeat(MAX_CANCEL_GROUP_LEN + 1);
        assert!(SearchCancelToken::begin(Some(&overlong), Some(1)).is_none());
        assert!(cancel_search(overlong.clone(), 1).await.is_err());
        assert!(CANCEL_GROUPS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .peek(&overlong)
            .is_none());
    }

    /// A search that goes stale while the files are being stat'ed stops there:
    /// no file is read and nothing is stored.
    #[tokio::test]
    async fn test_cancel_during_signatures_stops_before_any_scan() {
        let temp_dir = TempDir::new().unwrap();
        let projects_path = temp_dir.path().join("projects");
        let project_dir = projects_path.join("p");
        let files: Vec<PathBuf> = (0..=CANCEL_CHECK_INTERVAL * 2)
            .map(|i| {
                write_session(
                    &project_dir,
                    &format!("s{i}.jsonl"),
                    &[create_sample_user_message(
                        &format!("u{i}"),
                        "s",
                        "sigProbe11",
                    )],
                )
            })
            .collect();

        let group = "test-cancel-signatures";
        let checks = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&checks);
        set_cancel_check_hook(&projects_path, move |idx| {
            seen.lock().unwrap().push(idx);
            if idx >= CANCEL_CHECK_INTERVAL {
                cancel_search_group(group, 1);
            }
        });
        let result = search_with(
            &temp_dir,
            "sigProbe11",
            serde_json::json!({}),
            Some((group, 1)),
        )
        .await;
        clear_cancel_check_hook(&projects_path);

        assert_eq!(result.unwrap_err(), SEARCH_CANCELLED);
        assert_eq!(*checks.lock().unwrap(), [0, CANCEL_CHECK_INTERVAL]);
        assert!(files.iter().all(|file| test_scan_count(file) == 0));
        assert!(!cached_entry_exists(&temp_dir, "sigProbe11"));
    }

    /// A narrowed search that finishes after a full one of the same query
    /// keeps the full one's still-valid file matches instead of overwriting
    /// them with its partial table.
    #[tokio::test]
    async fn test_narrowed_store_keeps_matches_of_a_concurrent_full_search() {
        let temp_dir = TempDir::new().unwrap();
        let projects = temp_dir.path().join("projects");
        let wanted = write_session(
            &projects.join("p-wanted"),
            "s1.jsonl",
            &[create_sample_user_message("w1", "s1", "mergeProbe12")],
        );
        let other = write_session(
            &projects.join("p-other"),
            "s2.jsonl",
            &[create_sample_user_message("o1", "s2", "mergeProbe12")],
        );
        let claude_path = temp_dir.path().to_string_lossy().to_string();

        // While the narrowed search reads its file, a full search of the same
        // query runs to the end and stores both files.
        let fired = Arc::new(AtomicBool::new(false));
        let hook_fired = Arc::clone(&fired);
        let hook_path = claude_path.clone();
        set_cancel_check_hook(&wanted, move |_| {
            if !hook_fired.swap(true, Ordering::SeqCst) {
                let full = search_messages_blocking(
                    hook_path.clone(),
                    "mergeProbe12".to_string(),
                    serde_json::json!({}),
                    Some(1000),
                    None,
                )
                .unwrap();
                assert_eq!(full.len(), 2);
            }
        });
        let narrowed = search_with(
            &temp_dir,
            "mergeProbe12",
            serde_json::json!({ "projects": ["p-wanted"] }),
            None,
        )
        .await;
        clear_cancel_check_hook(&wanted);
        assert_eq!(uuids(&narrowed.unwrap()), ["w1"]);
        assert!(fired.load(Ordering::SeqCst));
        assert_eq!(test_scan_count(&other), 1, "read once, by the full search");

        let full = search_with(&temp_dir, "mergeProbe12", serde_json::json!({}), None)
            .await
            .unwrap();
        assert_eq!(full.len(), 2);
        assert_eq!(
            test_scan_count(&other),
            1,
            "the full search's matches survive the narrowed store"
        );
    }

    /// `search_all_providers` stops at once on a cancel instead of logging the
    /// error and moving on to the next provider.
    ///
    /// Limit: this checks the returned error only. Without the
    /// `Err(e) if e == SEARCH_CANCELLED => return Err(e)` arms the command
    /// still fails the same way at the next stage check; what the arms add is
    /// that no `log::warn!` is written for a cancel, which this test (with no
    /// logger installed) does not observe.
    #[tokio::test]
    async fn test_search_all_providers_returns_the_cancel_error() {
        let temp_dir = TempDir::new().unwrap();
        let file = write_session(
            &temp_dir.path().join("projects").join("p"),
            "s.jsonl",
            &[create_sample_user_message("u1", "s", "allProbe10")],
        );
        let claude_path = temp_dir.path().to_string_lossy().to_string();
        let run = |group: Option<&str>, seq: Option<u64>| {
            crate::commands::multi_provider::search_all_providers(
                Some(claude_path.clone()),
                "allProbe10".to_string(),
                Some(vec!["claude".to_string()]),
                None,
                None,
                None,
                None,
                Some(false),
                None,
                group.map(str::to_string),
                seq,
            )
        };

        assert_eq!(run(None, None).await.unwrap().len(), 1);

        cancel_search_group("test-all-early", 5);
        assert_eq!(
            run(Some("test-all-early"), Some(5)).await.unwrap_err(),
            SEARCH_CANCELLED
        );

        clear_search_cache_for_test();
        set_cancel_check_hook(&file, |_| cancel_search_group("test-all-mid", 1));
        let mid = run(Some("test-all-mid"), Some(1)).await;
        clear_cancel_check_hook(&file);
        assert_eq!(mid.unwrap_err(), SEARCH_CANCELLED);
    }
}
