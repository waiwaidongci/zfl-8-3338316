export const VALID_STATUSES = ["draft", "scanning", "completed", "confirmed"];

export const ALLOWED_TRANSITIONS = {
  draft: ["scanning"],
  scanning: ["completed"],
  completed: ["confirmed"],
  confirmed: []
};

export const PROTECTED_STATUSES = ["rented", "inspection", "scrapped"];
