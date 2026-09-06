import assert from "node:assert/strict";
import test from "node:test";
import { assessDiscoveryCandidate, assessEvidenceRelevance, assessRelevance, classifyDiscoveryCandidate } from "../src/relevance.js";

test("rejects rules, privacy, and FAQ pages for ordinary product research", () => {
  const result = assessRelevance({
    query: "Türk forumlarında gemi bakım yazılımı kullanıcı deneyimleri",
    title: "Technopat Sosyal Kuralları",
    text: "Kullanım koşulları ve gizlilik bildirimi.",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "system_page");
});

test("rejects recruitment posts for ordinary product-experience research", () => {
  const result = assessRelevance({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["NS5 ship maintenance", "planned maintenance system PMS"],
    title: "Senior Maintenance Engineer - Maritime Recruiters",
    text: "The candidate shall be proficient in planned maintenance tracking and reporting systems.",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "non_experience_page");
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

test("maritime sampled indexes admit shipboard work-list titles for direct verification", () => {
  const result = assessDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["NS5 ship maintenance", "planned maintenance system PMS"],
    title: "Generating and maintaining shipboard work lists",
    text: "",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.accepted, true);
  assert.equal(result.reason, "domain_candidate");
});

test("maritime sampled-index recall does not admit unrelated port announcements", () => {
  const result = assessDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["NS5 ship maintenance", "planned maintenance system PMS"],
    title: "Port authority announces a new terminal",
    text: "Shipping traffic and berth capacity news.",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.accepted, false);
});

test("classifies vessel-to-shore reporting as a related maritime software lead", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["vessel-to-shore reporting software"],
    title: "Looking for suggestions for vessel to shore reporting software",
    text: "Need daily reports from ship to office.",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "related");
});

test("does not classify generic marine operations reports as related software leads", () => {
  const result = classifyDiscoveryCandidate({
    title: "National maritime centers monthly reports performance",
    text: "Marine operations centre monthly report",
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["vessel-to-shore reporting software"],
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "rejected");
});

test("does not classify unrelated maritime software as a maintenance-adjacent lead", () => {
  const result = classifyDiscoveryCandidate({
    title: "Problems with Capt Joe's deck license software",
    text: "Maritime exam preparation software discussion",
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["vessel management software"],
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "rejected");
});

test("classifies a ship-engineering career page as rejected rather than a related lead", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    title: "Gemi İnşaatı ve Gemi Makineleri Mühendisliği Bölümü Bilgi",
    text: "Kariyer fırsatları ve bölüm hakkında sorular.",
    domainTags: ["maritime"],
  });

  assert.equal(result.kind, "rejected");
});

test("does not promote a vessel inspection notice to a maritime software candidate", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["planned maintenance system PMS", "vessel management software"],
    title: "Towing vessel inspections look like maybe not",
    text: "Inspection rules and notice requirements.",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "rejected");
});

test("does not restore a maritime job posting through the maintenance fallback", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["ShipManager planned maintenance"],
    title: "Planned maintenance engineer - Red The Consultancy Glasgow",
    text: "Position available for a maintenance engineer.",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "rejected");
});

test("rejects a maritime maintenance job title without an employer keyword", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["planned maintenance system PMS"],
    title: "Director of vessel maintenance preservation engineering",
    text: "",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "rejected");
});

test("rejects an NTSB maintenance news item before it becomes a read candidate", () => {
  const result = classifyDiscoveryCandidate({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["planned maintenance system PMS"],
    title: "NTSB critical maintenance error leads to engine room fire",
    text: "Official accident report.",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "rejected");
});

test("direct evidence requires a narrative in the extracted post rather than an experience label in the title", () => {
  const result = assessEvidenceRelevance({
    query: "ship maintenance software",
    title: "Ship maintenance software experience",
    text: "A product overview prepared by the publisher.",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "non_user_narrative");
});

test("rejects maritime software news before it becomes a related lead", () => {
  const result = classifyDiscoveryCandidate({
    query: "ship maintenance software",
    title: "Ship maintenance software news",
    text: "I use this platform on board our vessel.",
    domainTags: ["maritime", "professional"],
  });

  assert.equal(result.kind, "rejected");
});

test("direct maritime evidence independently requires a maintenance workflow", () => {
  const result = assessEvidenceRelevance({
    query: "gemi bakım yazılımı kullanıcı deneyimleri",
    variants: ["vessel management software"],
    title: "Vessel management software discussion",
    text: "I use this software on board our vessel every day.",
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "insufficient_term_overlap");
});
