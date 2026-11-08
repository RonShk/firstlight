import type { Agent, PolicyForm, StateCode } from "../../types/sim";

export const HOME_STATE: StateCode = "OK";

/** Mirrors statefarm_rag_manifest.csv. Policies reference these ids so RAG can filter by doc_id. */
export const POLICY_FORMS: PolicyForm[] = [
  { id: "SF-AUTO-TX", line: "auto", name: "Personal Car Policy", formNumber: "9843C", state: "TX", personaFit: "single/married drivers; any age", url: "https://www.statefarm.com/content/dam/sf-library/en-us/pca-endorsement/auto/9843C.pdf" },
  { id: "SF-AUTO-MT", line: "auto", name: "Car Policy", formNumber: "9826C", state: "MT", personaFit: "rural/older drivers", url: "https://www.statefarm.com/content/dam/sf-library/en-us/pca-endorsement/auto/9826C.pdf" },
  { id: "SF-BIZAUTO-OH", line: "auto", name: "Business Car Policy", formNumber: "9635C", state: "OH", personaFit: "self-employed / small business owner", url: "https://statefarm.com/content/dam/sf-library/en-us/pca-endorsement/auto/9635C.pdf" },
  { id: "SF-HOME-CA", line: "home", name: "Homeowners Policy", formNumber: "HW-2105", state: "CA", personaFit: "homeowning family/couple; wildfire state", url: "https://www.statefarm.com/content/dam/sf-library/en-us/pca-endorsement/fire/HW-2105.pdf" },
  { id: "SF-HOME-ME", line: "home", name: "Homeowners Policy", formNumber: "HW-2119", state: "ME", personaFit: "homeowning family/couple", url: "https://www.maine.gov/pfr/insurance/sites/maine.gov.pfr.insurance/files/inline-files/hw-2119.pdf" },
  { id: "SF-HOME-OK", line: "home", name: "Homeowners Policy", formNumber: "HW-2136", state: "OK", personaFit: "homeowning family/couple; tornado state", url: "https://www.oid.ok.gov/wp-content/uploads/2019/08/040218_HW-2136-2017.pdf" },
  { id: "SF-UMB-WEB", line: "umbrella", name: "Personal Liability Umbrella", formNumber: "FP-7950", state: "multi", personaFit: "high-net-worth / families with teen drivers", url: "https://www.statefarm.com/insurance/liability/personal-umbrella-policy" },
];

export const FORMS_BY_ID = Object.fromEntries(POLICY_FORMS.map((f) => [f.id, f])) as Record<string, PolicyForm>;

/**
 * Everyone lives in the Oklahoma City metro, but home policies are spread across the
 * three homeowners forms we have so the RAG has breadth. Weights: mostly the OK form.
 */
export const HOME_FORM_WEIGHTS: [string, number][] = [
  ["SF-HOME-OK", 60],
  ["SF-HOME-CA", 20],
  ["SF-HOME-ME", 20],
];

export interface City {
  name: string;
  state: StateCode;
  lat: number;
  lon: number;
  /** How many of the 2,000 personas live here. */
  count: number;
  /** Spread of homes around the center, in degrees. */
  spread: number;
  areaCode: string;
  zips: string[];
  homeValue: [number, number];
  rural: number;
}

export const CITIES: City[] = [
  { name: "Moore", state: "OK", lat: 35.3395, lon: -97.4867, count: 90, spread: 0.03, areaCode: "405", zips: ["73160", "73165", "73170"], homeValue: [140_000, 340_000], rural: 0.04 },
  { name: "South Oklahoma City", state: "OK", lat: 35.395, lon: -97.535, count: 95, spread: 0.035, areaCode: "405", zips: ["73109", "73119", "73139", "73159", "73169"], homeValue: [110_000, 300_000], rural: 0.02 },
  { name: "Oklahoma City", state: "OK", lat: 35.49, lon: -97.52, count: 50, spread: 0.04, areaCode: "405", zips: ["73102", "73106", "73112", "73118", "73120"], homeValue: [130_000, 480_000], rural: 0.02 },
  { name: "Norman", state: "OK", lat: 35.2226, lon: -97.4395, count: 50, spread: 0.035, areaCode: "405", zips: ["73069", "73071", "73072"], homeValue: [150_000, 380_000], rural: 0.12 },
  { name: "Edmond", state: "OK", lat: 35.6528, lon: -97.4781, count: 25, spread: 0.035, areaCode: "405", zips: ["73003", "73013", "73034"], homeValue: [220_000, 520_000], rural: 0.08 },
  { name: "Midwest City", state: "OK", lat: 35.4495, lon: -97.3967, count: 25, spread: 0.025, areaCode: "405", zips: ["73110", "73130"], homeValue: [110_000, 260_000], rural: 0.03 },
  { name: "Del City", state: "OK", lat: 35.442, lon: -97.4409, count: 15, spread: 0.015, areaCode: "405", zips: ["73115"], homeValue: [90_000, 190_000], rural: 0.01 },
  { name: "Mustang", state: "OK", lat: 35.3842, lon: -97.7245, count: 18, spread: 0.03, areaCode: "405", zips: ["73064"], homeValue: [180_000, 380_000], rural: 0.25 },
  { name: "Newcastle", state: "OK", lat: 35.2473, lon: -97.5998, count: 16, spread: 0.03, areaCode: "405", zips: ["73065"], homeValue: [190_000, 420_000], rural: 0.35 },
  { name: "Yukon", state: "OK", lat: 35.5067, lon: -97.7625, count: 16, spread: 0.03, areaCode: "405", zips: ["73099"], homeValue: [170_000, 360_000], rural: 0.15 },
];

/** Fictional State Farm agent offices. Each persona is assigned the nearest one in their state. */
export const AGENTS: Agent[] = [
  { id: "AG-01", name: "Dana Whitfield", city: "Moore", state: "OK", phone: "(405) 555-0142", lat: 35.335, lon: -97.48 },
  { id: "AG-02", name: "Marcus Reyes", city: "Moore", state: "OK", phone: "(405) 555-0177", lat: 35.326, lon: -97.505 },
  { id: "AG-03", name: "Priya Natarajan", city: "South Oklahoma City", state: "OK", phone: "(405) 555-0118", lat: 35.405, lon: -97.55 },
  { id: "AG-04", name: "Tom Haskell", city: "South Oklahoma City", state: "OK", phone: "(405) 555-0193", lat: 35.38, lon: -97.5 },
  { id: "AG-05", name: "Keisha Lawson", city: "Oklahoma City", state: "OK", phone: "(405) 555-0126", lat: 35.49, lon: -97.52 },
  { id: "AG-06", name: "Renee Begay", city: "Norman", state: "OK", phone: "(405) 555-0131", lat: 35.222, lon: -97.44 },
  { id: "AG-07", name: "Caleb Fontaine", city: "Edmond", state: "OK", phone: "(405) 555-0165", lat: 35.653, lon: -97.478 },
  { id: "AG-08", name: "Victor Huang", city: "Midwest City", state: "OK", phone: "(405) 555-0156", lat: 35.449, lon: -97.4 },
  { id: "AG-09", name: "Shonda Graves", city: "Mustang", state: "OK", phone: "(405) 555-0110", lat: 35.384, lon: -97.724 },
  { id: "AG-10", name: "Luis Cardenas", city: "Yukon", state: "OK", phone: "(405) 555-0172", lat: 35.507, lon: -97.762 },
];

export const NAMES = {
  senior: {
    m: ["Robert", "James", "John", "William", "Richard", "Charles", "Donald", "Gary", "Larry", "Ronald", "Dennis", "Jerry", "Harold", "Walter", "Earl", "Frank", "Raymond", "Eugene"],
    f: ["Mary", "Patricia", "Linda", "Barbara", "Carol", "Sandra", "Sharon", "Judith", "Donna", "Nancy", "Betty", "Shirley", "Margaret", "Dorothy", "Joyce", "Gloria", "Norma", "Rosa"],
  },
  adult: {
    m: ["Michael", "David", "Christopher", "Jason", "Brian", "Kevin", "Mark", "Jeffrey", "Scott", "Eric", "Steven", "Anthony", "Juan", "Carlos", "Jose", "Luis", "Tuan", "Rahul", "Darnell", "Travis"],
    f: ["Jennifer", "Lisa", "Michelle", "Amy", "Angela", "Melissa", "Kimberly", "Stephanie", "Heather", "Rachel", "Maria", "Monica", "Tiffany", "Erin", "Priya", "Lan", "Keisha", "Nicole", "Crystal", "Veronica"],
  },
  young: {
    m: ["Joshua", "Tyler", "Brandon", "Ryan", "Austin", "Jacob", "Justin", "Andrew", "Kyle", "Marcus", "Diego", "Jordan", "Ethan", "Daniel", "Nathan", "Isaiah", "Hunter", "Malik"],
    f: ["Ashley", "Jessica", "Emily", "Sarah", "Brittany", "Samantha", "Lauren", "Hannah", "Megan", "Kayla", "Alexis", "Destiny", "Gabriela", "Taylor", "Madison", "Aaliyah", "Mia", "Jasmine"],
  },
  child: {
    m: ["Liam", "Noah", "Elijah", "Oliver", "Lucas", "Mason", "Logan", "Mateo", "Aiden", "Jackson", "Caleb", "Grayson", "Ezra", "Leo", "Wyatt", "Jayden"],
    f: ["Olivia", "Emma", "Ava", "Sophia", "Isabella", "Mia", "Harper", "Evelyn", "Abigail", "Chloe", "Aria", "Camila", "Lily", "Zoe", "Nora", "Layla"],
  },
};

export const LAST_NAMES = [
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez",
  "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White",
  "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Torres",
  "Nguyen", "Hill", "Flores", "Green", "Adams", "Nelson", "Baker", "Hall", "Rivera", "Campbell", "Mitchell", "Carter", "Roberts",
  "Phillips", "Evans", "Turner", "Diaz", "Parker", "Cruz", "Edwards", "Collins", "Reyes", "Stewart", "Morris", "Morales", "Murphy",
  "Cook", "Rogers", "Gutierrez", "Ortiz", "Morgan", "Cooper", "Peterson", "Bailey", "Reed", "Kelly", "Howard", "Ramos", "Kim",
  "Ward", "Richardson", "Watson", "Brooks", "Chavez", "Wood", "Bennett", "Gray", "Mendoza", "Hughes", "Price", "Alvarez",
  "Castillo", "Sanders", "Patel", "Myers", "Long", "Ross", "Foster", "Jimenez", "Tran", "Pham", "Chen", "Wang", "Singh",
  "Okafor", "Haddad", "Cohen", "Novak", "Begay", "Harjo", "Lindqvist", "Yamamoto", "Bui", "Vu",
];

export const STREETS = [
  "Oak", "Maple", "Cedar", "Pine", "Elm", "Willow", "Main", "Meadow", "Sunset", "Ridge", "Hickory", "Prairie", "Briarwood",
  "Country Club", "Santa Fe", "Redbud", "Magnolia", "Lakeview", "Mesquite", "Juniper", "Harbor", "Birch", "Aspen", "Vineyard",
];
export const STREET_TYPES = ["St", "Ave", "Dr", "Ln", "Ct", "Rd", "Way", "Pl", "Blvd", "Cir"];

export const OCCUPATIONS = {
  student: ["College student", "Nursing student", "Community college student"],
  young: ["Barista", "Line cook", "Retail associate", "Warehouse associate", "Apprentice electrician", "Dental assistant", "Server", "Bank teller", "Junior developer"],
  adult: ["Teacher", "Registered nurse", "Electrician", "Software developer", "Accountant", "Truck driver", "Sales manager", "Pharmacist", "Oilfield technician", "Police officer", "Mechanic", "HR manager", "Paramedic", "Civil engineer"],
  selfEmployed: ["Small business owner", "General contractor", "Hair stylist (own salon)", "Real estate agent", "Rancher", "Landscaping company owner", "Food truck owner", "Freelance photographer"],
  retired: ["Retired teacher", "Retired machinist", "Retired nurse", "Retired postal worker", "Retired Air Force", "Retired farmer", "Retired"],
};

export const MEDICAL_NEEDS = {
  senior: ["Insulin-dependent diabetes", "Home oxygen", "Dialysis 3×/week", "Heart condition", "Early-stage dementia", "Uses a walker"],
  adult: ["Insulin-dependent diabetes", "Pregnant (third trimester)", "Severe asthma"],
  child: ["Asthma (rescue inhaler)", "Type 1 diabetes", "Newborn", "Autism, sensitive to noise"],
};

export interface VehicleModel {
  make: string;
  model: string;
  msrp: [number, number];
  tags: ("truck" | "family" | "economy" | "luxury" | "awd" | "ev")[];
}

export const VEHICLE_MODELS: VehicleModel[] = [
  { make: "Ford", model: "F-150", msrp: [38_000, 72_000], tags: ["truck"] },
  { make: "Chevrolet", model: "Silverado 1500", msrp: [38_000, 68_000], tags: ["truck"] },
  { make: "Ram", model: "1500", msrp: [40_000, 70_000], tags: ["truck"] },
  { make: "Toyota", model: "Tacoma", msrp: [32_000, 52_000], tags: ["truck"] },
  { make: "Toyota", model: "Camry", msrp: [27_000, 36_000], tags: ["economy"] },
  { make: "Honda", model: "Civic", msrp: [24_000, 31_000], tags: ["economy"] },
  { make: "Hyundai", model: "Elantra", msrp: [21_000, 28_000], tags: ["economy"] },
  { make: "Nissan", model: "Altima", msrp: [26_000, 33_000], tags: ["economy"] },
  { make: "Honda", model: "CR-V", msrp: [30_000, 40_000], tags: ["family"] },
  { make: "Toyota", model: "RAV4", msrp: [30_000, 41_000], tags: ["family", "awd"] },
  { make: "Subaru", model: "Outback", msrp: [30_000, 42_000], tags: ["family", "awd"] },
  { make: "Toyota", model: "Sienna", msrp: [39_000, 55_000], tags: ["family"] },
  { make: "Honda", model: "Odyssey", msrp: [38_000, 52_000], tags: ["family"] },
  { make: "Kia", model: "Sorento", msrp: [32_000, 46_000], tags: ["family"] },
  { make: "Ford", model: "Explorer", msrp: [38_000, 55_000], tags: ["family"] },
  { make: "Chevrolet", model: "Equinox", msrp: [28_000, 36_000], tags: ["family"] },
  { make: "Jeep", model: "Grand Cherokee", msrp: [40_000, 62_000], tags: ["family", "awd"] },
  { make: "Tesla", model: "Model 3", msrp: [40_000, 54_000], tags: ["ev"] },
  { make: "Tesla", model: "Model Y", msrp: [45_000, 58_000], tags: ["ev", "family"] },
  { make: "BMW", model: "X5", msrp: [66_000, 90_000], tags: ["luxury"] },
  { make: "Cadillac", model: "Escalade", msrp: [82_000, 108_000], tags: ["luxury"] },
  { make: "Lexus", model: "RX 350", msrp: [50_000, 66_000], tags: ["luxury"] },
  { make: "Buick", model: "Enclave", msrp: [42_000, 56_000], tags: ["family"] },
];
