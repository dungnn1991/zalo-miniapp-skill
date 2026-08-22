// text-match.mjs — two-way Vietnamese/English normalization shared by the routing code.
// Extracted verbatim from bootstrap.mjs v0.3.2 (`normalizeVi`, `matchNormalized`) so the
// ranker and the bootstrap gate can never drift apart (CONTRACT-plan34, Subagent A).
// Behaviour is unchanged — do not "improve" the matcher here without a corpus case.

// Đa ngôn ngữ (config officialTemplates.matchNormalization): brief VN có dấu/không dấu/EN
// đều phải khớp — normalize CẢ HAI CHIỀU: lowercase + NFD bỏ dấu + đ→d.
// 'quần áo' / 'quan ao' / 'Quần Áo' → 'quan ao'. Chỉ dùng cho SO KHỚP — input.json giữ nguyên văn.
export function normalizeVi(s) {
  return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Multi-word phrase: substring trên chuỗi normalized (an toàn). Single word: word-boundary
// trên chuỗi normalized để tránh false positive kiểu 'dam'/'vay' lẫn trong từ EN khác.
export function matchNormalized(normText, keyword) {
  const nk = normalizeVi(keyword);
  if (nk.includes(' ')) return normText.includes(nk);
  return new RegExp(`(^|[^a-z0-9])${escapeRe(nk)}($|[^a-z0-9])`).test(normText);
}

// Same rule as matchNormalized, but also returns WHERE it matched so callers can quote a
// real span of the raw brief as evidence (intent-envelope guardrail: evidence spans must
// exist in the brief).
// normalizeVi is index-preserving for VN/EN input (lowercase, strip combining marks, đ→d
// are all 1:1 on code points here); when that assumption breaks (length differs) we fall
// back to quoting the normalized text instead of slicing the raw string at a wrong offset.
export function matchSpan(normText, rawText, keyword) {
  const nk = normalizeVi(keyword);
  if (!nk) return null;
  let start;
  if (nk.includes(' ')) {
    start = normText.indexOf(nk);
    if (start < 0) return null;
  } else {
    const m = new RegExp(`(^|[^a-z0-9])${escapeRe(nk)}($|[^a-z0-9])`).exec(normText);
    if (!m) return null;
    start = m.index + m[1].length;
  }
  const source = String(rawText).length === normText.length ? String(rawText) : normText;
  return { keyword: nk, start, span: source.slice(start, start + nk.length) };
}
