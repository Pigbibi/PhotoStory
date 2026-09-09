import {LANGUAGES} from './languages.mjs';
import {aspectValue,photoFrame} from './framing.mjs';
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
export function validId(value) {
  return typeof value === "string" && idPattern.test(value);
}
function text(value, name, max, required = true) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new Error(`invalid_${name}`);
  return value.trim();
}
function translations(value) {
  if(value===undefined)return {};
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid_translation');
  const result={};
  for(const [locale,label] of Object.entries(value)){
    if(!Object.hasOwn(LANGUAGES,locale)||!label||typeof label!=='object')throw new Error('invalid_translation');
    result[locale]={title:text(label.title,'title',160),reason:text(label.reason,'reason',600,false)};
  }
  return {translations:result};
}
export function validateDraft(input) {
  if (!input || !validId(input.id)) throw new Error("invalid_id");
  const title = text(input.title, "title", 160),
    caption = text(input.caption, "caption", 1800),
    hashtags = text(input.hashtags ?? "", "hashtags", 350, false);
  if (
    !Array.isArray(input.photos) ||
    input.photos.length < 1 ||
    input.photos.length > 8
  )
    throw new Error("invalid_photos");
  const seen = new Set();
  const photos = input.photos.map((p) => {
    if (!validId(p.id)) throw new Error("invalid_photo");
    if (seen.has(p.id)) throw new Error("duplicate_photo");
    seen.add(p.id);
    return { id: p.id, alt: text(p.alt ?? "Landscape photo", "alt", 300), frame: photoFrame(p.frame) };
  });
  return {
    id: input.id,
    title,
    ...translations(input.translations),
    caption,
    hashtags,
    photos,
    aspect: aspectValue(input.aspect),
    status: "draft",
    version: 1,
    reason: text(input.reason ?? "", "reason", 600, false),
  };
}
export function reviewDraft(current, input, now=Date.now()) {
  if (input.version !== current.version) throw new Error("version_conflict");
  if(input.action==='trash' && ['draft','approved'].includes(current.status))
    return {...current,status:'trash',trashedAt:now,version:current.version+1};
  if(input.action==='restore' && current.status==='trash'){
    const {trashedAt,...rest}=current;
    return {...rest,status:'draft',version:current.version+1};
  }
  if(current.status==='trash')throw new Error('invalid_action');
  if (!["save", "approve", "return"].includes(input.action))
    throw new Error("invalid_action");
  const next = validateDraft({
    ...input,
    id: current.id,
    reason: current.reason,
    translations:input.title===current.title?current.translations:undefined,
  });
  if (next.photos.some((p) => !current.photos.some((c) => c.id === p.id)))
    throw new Error("unknown_photo");
  const normalizedCurrent = validateDraft(current);
  const unchanged = ["title", "caption", "hashtags", "photos", "aspect"].every(
    (k) => JSON.stringify(next[k]) === JSON.stringify(normalizedCurrent[k]),
  );
  if (input.action === "approve" && !unchanged)
    throw new Error("save_before_approval");
  return {
    ...next,
    version: current.version + 1,
    ...(unchanged && input.action==="save" && current.status==="approved" && current.approvalSource ? {approvalSource:current.approvalSource} : {}),
    status:
      input.action === "approve"
        ? "approved"
        : input.action === "return" || !unchanged
          ? "draft"
          : current.status,
  };
}
