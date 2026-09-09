import test from "node:test";
import assert from "node:assert/strict";
import { validateDraft, reviewDraft } from "../worker/review.mjs";
const draft = () => ({
  id: "trip-1",
  title: "海岸",
  caption: "A quiet coast.",
  hashtags: "#Thailand",
  photos: [{ id: "p1", alt: "Coast" }],
  status: "draft",
  version: 1,
});
test("approval is bound to the reviewed version", () => {
  assert.equal(
    reviewDraft(draft(), { ...draft(), action: "approve" }).status,
    "approved",
  );
  assert.throws(
    () => reviewDraft(draft(), { ...draft(), version: 0, action: "approve" }),
    /conflict/,
  );
});
test("editing an approved draft invalidates approval", () => {
  assert.equal(
    reviewDraft(
      { ...draft(), status: "approved" },
      { ...draft(), action: "save", caption: "Changed." },
    ).status,
    "draft",
  );
});
test("cannot publish through review actions", () => {
  assert.throws(
    () => reviewDraft(draft(), { ...draft(), action: "publish" }),
    /invalid_action/,
  );
});
test("cannot inject a new photo during review", () => {
  assert.throws(
    () =>
      reviewDraft(draft(), {
        ...draft(),
        action: "save",
        photos: [{ id: "unknown", alt: "Coast" }],
      }),
    /unknown_photo/,
  );
});
test("duplicate photos and empty captions are rejected", () => {
  assert.throws(() => validateDraft({ ...draft(), caption: "" }), /caption/);
  assert.throws(
    () =>
      validateDraft({
        ...draft(),
        photos: [...draft().photos, ...draft().photos],
      }),
    /duplicate/,
  );
});
test("untrusted generated status is reset on import", () => {
  assert.equal(
    validateDraft({ ...draft(), status: "published" }).status,
    "draft",
  );
});
test("removing all photos is rejected", () => {
  assert.throws(
    () => reviewDraft(draft(), { ...draft(), action: "save", photos: [] }),
    /photos/,
  );
});
test("image URLs and HTML are never interpreted by the model validator", () => {
  const d = validateDraft({
    ...draft(),
    photos: [{ id: "p1", alt: "<script>", url: "https://evil.invalid" }],
  });
  assert.equal(d.photos[0].url, undefined);
});
