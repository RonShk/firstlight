// Sample customer texts covering triage 1-4, all claim types, and a non-claim.
// `expect` is for a human (and run-samples.ts) checking the output; the pipeline never sees it.

export interface SampleText {
  id: string;
  from: string;
  text: string;
  expect: {
    triage: 1 | 2 | 3 | 4 | null; // null: not a claim
    claim_types: ("home" | "auto" | "umbrella")[];
    note: string;
  };
}

export const SAMPLE_TEXTS: SampleText[] = [
  {
    id: "rivera-hurricane",
    from: "+15550100010",
    text:
      "This is Maria Rivera in Katy. The hurricane tore a bunch of shingles off our roof and a tree " +
      "fell through our back fence. Now water is coming in through the ceiling in the kids' room. " +
      "The power was out for two days so all the food in the fridge spoiled, maybe $250. We can't " +
      "stay here with the leak and the two little ones, so we need a hotel for a few nights.",
    expect: { triage: 3, claim_types: ["home"],
              note: "food + hotel green and approved; fence yellow -> review; ceiling red -> review; roof -> review" },
  },
  {
    id: "green-home-food",
    from: "+15550100001",
    text:
      "Hi, the storm knocked our power out for two days. All the food in the fridge and freezer " +
      "spoiled, probably around $300 worth. Everyone here is fine and the house is okay.",
    expect: { triage: 1, claim_types: ["home"], note: "food spoilage approved, citing Refrigerated Products" },
  },
  {
    id: "yellow-auto-hail",
    from: "+15550100002",
    text:
      "Hail storm last night cracked my windshield and put dents all over the hood and roof of my " +
      "car. It still runs but I can't see well enough to drive it safely. Can I get a rental car " +
      "while it's in the shop?",
    expect: { triage: 2, claim_types: ["auto"], note: "rental car approved; body and glass repair -> review" },
  },
  {
    id: "red-home-tornado",
    from: "+15550100003",
    text:
      "The tornado took most of our roof off and rain is pouring into the bedrooms, we can't stay " +
      "here. My son cut his arm badly on broken glass and we're at the ER now. We need somewhere " +
      "to sleep tonight.",
    expect: { triage: 3, claim_types: ["home"], note: "hotel approved; roof -> review; son already at the ER, so not 911" },
  },
  {
    id: "red-umbrella-flood-car",
    from: "+15550100004",
    text:
      "My car got pushed by the flood water and slammed into my neighbor's house. Their whole " +
      "front wall caved in and their daughter was hurt and taken to the hospital. I think they're " +
      "going to sue me.",
    expect: { triage: 3, claim_types: ["umbrella", "auto"], note: "third-party liability: all human review" },
  },
  {
    id: "yellow-home-tsunami-flood",
    from: "+15550100005",
    text:
      "The tsunami surge flooded our whole ground floor. Couch, rugs, the washer and dryer are " +
      "all ruined. No one was hurt, we're staying with my sister.",
    expect: { triage: 3, claim_types: ["home"], note: "flood exclusion cited; human review" },
  },
  {
    id: "triage4-trapped-rising-water",
    from: "+15550100006",
    text:
      "Water is coming up the stairs and my dad can't walk, we're trapped on the second floor. " +
      "Our car is underwater too.",
    expect: { triage: 4, claim_types: [], note: "Call 911 now, no claim processing" },
  },
  {
    id: "triage4-typos",
    from: "+15550100007",
    text: "pls hlp watr comin in fast cant get my grandma out of the basment",
    expect: { triage: 4, claim_types: [], note: "typos: still Call 911 now" },
  },
  {
    id: "triage4-spanish",
    from: "+15550100008",
    text: "ayuda el agua sube y mis hijos están conmigo en el techo",
    expect: { triage: 4, claim_types: [], note: "Spanish: Call 911 now" },
  },
  {
    id: "off-topic-hours",
    from: "+15550100009",
    text: "hello, what are your office hours?",
    expect: { triage: null, claim_types: [], note: "not a claim: help reply, nothing logged" },
  },
];
