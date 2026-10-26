/**
 * 输入粘贴的**共享语义**（PromptInput 与插件场景共用）。
 *
 * 只抽两条输入真正同源的东西：
 * 1. **粘贴管线**——载荷清洗（win32 输入记录残渣、终端控制字节、\r 规整）；
 * 2. **可编辑文本清洗**——控制字符与 ANSI 的收敛规则。
 *
 * 多行、历史与图片 chip 折叠仍属聊天页编辑器自己的能力，这里不复制。
 * 异步落点守则（读回时必须用当下最新的文本/光标）属于调用方。
 */

import stripAnsi from 'strip-ansi'

/**
 * Editable prompt text must have one stable source-to-screen geometry. The
 * renderer interprets ANSI as zero-width styling and expands tabs relative to
 * global tab stops; keeping either in `value` would let wrapping/click mapping
 * count different cells and could split an escape sequence during selection.
 * Strip terminal controls and expand tabs at ingress while preserving newlines.
 */
const EDITABLE_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/u

/**
 * Raw win32-input-mode records (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`) that reached the
 * editable buffer as text instead of being translated. `stripAnsi` consumes the
 * record head and leaves its terminating `_` in the draft — the stray
 * underscore users see after a multi-line paste (issue #1090). Only the full
 * record grammar (exactly five `;` separators) matches, so a real `_` and
 * ordinary bracket text survive untouched.
 *
 * This rule is the DELETION side of the paste-integrity contract, and the
 * split of responsibility with the parser is deliberate (T-FIX-06): the
 * parser's record decoders (`parse-keypress.ts` `decodeWin32RecordText` /
 * `decodeLiteralRecordText`) REWRITE a record stream they can prove is one —
 * a transition pair, near-miss spellings included — and this rule then deletes
 * whatever complete record is left over. So a shape the decoder declines
 * (a lone record with no transition evidence, an ESC-less tail) has its bytes
 * deleted HERE, not rescued: "the decoder keeps its bytes" is a statement
 * about the rewrite, never about the text the user finally sees. That residual
 * is pinned in `scripts/verify-paste-integrity.tsx` (m13-m15).
 *
 * Shape source: the same grammar `parse-keypress.ts` decodes at token level
 * (`WIN32_INPUT_RE`) and rewrites back into characters for a leaked payload
 * (`WIN32_RECORD_TEXT_RE`); the expressions must stay in sync.
 */
const WIN32_RECORD_RESIDUE = /\u001b\[\d*(?:;\d*){5}_/gu

/**
 * The same record with its ESC byte missing: what a record split across reads
 * leaves behind once its ESC was consumed as a key event. Printable, so it
 * survives `sanitizeEditableText`'s control probe untouched; typed text keeps
 * it because only a paste payload can carry a partial record.
 *
 * Two anchors keep the strip from deleting payload data (ADR-0008: a deletion
 * needs evidence that the shape CANNOT be a payload character):
 *
 * - `(?<!\u001b)` — a tail may never bite into a COMPLETE record. Without this
 *   anchor the strip sliced `ESC[13;28;13;1;0;1_ravo` down the middle, and
 *   `stripAnsi` then ate the orphan ESC together with the payload `r`
 *   (measured: 50 of the 94 printable followers were edible).
 * - `(?<![\p{L}\p{N}])` — a record-shaped run welded into the payload's own
 *   word (`…_x[13;28;13;1;0;1_y`) is indistinguishable from payload text and
 *   must stay visible (16 characters in the minimum case). A run that stands
 *   alone as its own protocol token is still the #1097 residue; the residual
 *   is recorded in T06-SUMMARY.
 *
 * The strip also runs AFTER {@link WIN32_RECORD_RESIDUE} — see
 * {@link sanitizePastedText} for why that order is a contract.
 */
const WIN32_RECORD_RESIDUE_TAIL = /(?<!\u001b)(?<![\p{L}\p{N}])\[\d*(?:;\d*){5}_/gu

/**
 * Normalize editable text so no terminal control characters remain in state.
 */
export function sanitizeEditableText(text: string): string {
  // Fast path for ordinary and multi-line drafts: newline is intentionally
  // absent from the probe, so large clean text returns without the
  // stripAnsi/control-normalization passes.
  if (!EDITABLE_CONTROL.test(text)) return text
  // Record residue goes first: `stripAnsi` would consume the CSI head and
  // leave only the terminating `_` behind.
  return stripAnsi(text.replace(WIN32_RECORD_RESIDUE, ''))
    .replace(/\r\n?/gu, '\n')
    .replace(/\t/gu, '        ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
}

/**
 * Paste-payload ingress: consume a split record's ESC-less tail before
 * normalizing. The tail is printable, so it would survive
 * `sanitizeEditableText`'s control probe untouched; typed text keeps it
 * because only a paste payload can carry a partial record.
 *
 * The five separators only prove the *shape*, not that a record was split:
 * a user can legitimately paste the literal `[13;28;13;1;0;1_`. The tail rule
 * therefore keeps its two evidence requirements — the payload must carry a
 * complete ESC-bearing record, and the shape must stand alone as its own token
 * ({@link WIN32_RECORD_RESIDUE_TAIL}) — and, when they do not hold, the bytes
 * stay exactly as pasted (ADR-0002 zero-harm / ADR-0008 "keep it visible").
 */
export function sanitizePastedText(text: string): string {
  // Probe with String#match: the /g detection regex carries lastIndex state
  // across `.test` calls, so a previous success could skip a later match.
  const hasRecordStream = text.match(WIN32_RECORD_RESIDUE) !== null
  if (!hasRecordStream) return sanitizeEditableText(text)
  // Order is a contract (ADR-0002 decision 1, corrected): the COMPLETE records
  // go first, so the tail rule can never see a record's own body — otherwise
  // the record is sliced open and `stripAnsi` eats the orphan ESC plus the
  // payload character behind it. `sanitizeEditableText` then strips whatever
  // records are left.
  return sanitizeEditableText(
    text.replace(WIN32_RECORD_RESIDUE, '').replace(WIN32_RECORD_RESIDUE_TAIL, ''),
  )
}
