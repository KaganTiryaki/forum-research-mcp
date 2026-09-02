import assert from "node:assert/strict";
import test from "node:test";
import { assessRelevance } from "../src/relevance.js";

test("rejects rules, privacy, and FAQ pages for ordinary product research", () => {
  const result = assessRelevance({
    query: "Türk forumlarında gemi bakım yazılımı kullanıcı deneyimleri",
    title: "Technopat Sosyal Kuralları",
    text: "Kullanım koşulları ve gizlilik bildirimi.",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "system_page");
});

test("does not mistake Tori Amos for maritime maintenance software", () => {
  const result = assessRelevance({
    query: "gemi bakım yazılımı deneyimleri",
    variants: ["AMOS gemi bakım"],
    title: "Tori Amos konseri hakkında yorumlar",
    text: "Yeni albüm ve konser deneyimi.",
  });

  assert.equal(result.accepted, false);
});

test("accepts AMOS only with maritime maintenance context", () => {
  const result = assessRelevance({
    query: "gemi bakım yazılımı deneyimleri",
    variants: ["AMOS gemi bakım"],
    title: "AMOS gemi bakım sistemi kullanan var mı?",
    text: "Planlı bakım, yedek parça ve denetim hazırlığı deneyimleri.",
  });

  assert.equal(result.accepted, true);
});

test("does not over-filter a normal Turkish hardware discussion", () => {
  const result = assessRelevance({
    query: "RTX 5070 kullanıcı deneyimi",
    title: "RTX 5070 kullanıcı deneyimleri ve sıcaklık değerleri",
    text: "Kartı iki haftadır kullanıyorum; oyun performansı iyi.",
  });

  assert.equal(result.accepted, true);
});

test("allows system pages when the query explicitly asks about them", () => {
  const result = assessRelevance({
    query: "Technopat sosyal kuralları",
    title: "Technopat Sosyal Kuralları",
    text: "Forum kullanım kuralları.",
  });

  assert.equal(result.accepted, true);
});
