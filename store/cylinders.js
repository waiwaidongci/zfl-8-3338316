import { loadJson, saveJson, makeEvent, withJsonTx } from "./common.js";
import { addStatusHistory } from "./compatibility.js";

const FILE = "cylinders.json";
export const SEED = {
  cylinders: [
    {
      id: "CY-88001",
      gasType: "高纯氩",
      capacity: "40L",
      inspectionDue: "2026-07-20",
      location: "一号仓",
      status: "in_stock",
      customer: null,
      depositStatus: "none",
      fills: [{ id: "fill-1", filledAt: "2026-06-02", pressure: "13.5MPa", operator: "陈起" }],
      events: [{ id: "evt-1", type: "inbound", at: "2026-06-02T08:20:00.000Z", note: "初始入库" }]
    },
    {
      id: "CY-88002",
      gasType: "混合标准气",
      capacity: "8L",
      inspectionDue: "2026-06-28",
      location: "宁川检测",
      status: "rented",
      customer: "宁川检测",
      depositStatus: "paid",
      fills: [],
      events: [{ id: "evt-2", type: "outbound", at: "2026-05-10T10:00:00.000Z", note: "客户租借" }]
    }
  ]
};

export async function loadCylinders() {
  const db = await loadJson(FILE, SEED);
  return db.cylinders;
}

export async function saveCylinders(cylinders) {
  await saveJson(FILE, { cylinders });
}

export async function withCylindersTx(mutator) {
  return withJsonTx(FILE, SEED, async (db) => {
    return mutator(db.cylinders);
  });
}

export function findCylinder(cylinders, id) {
  return cylinders.find((c) => c.id === id) || null;
}

export const transitions = {
  inbound(cylinder, input) {
    const fromStatus = cylinder.status;
    cylinder.status = "in_stock";
    cylinder.location = input.location || "仓库";
    cylinder.customer = null;
    cylinder.depositStatus = "none";
    return { fromStatus, toStatus: "in_stock" };
  },
  outbound(cylinder, input) {
    const fromStatus = cylinder.status;
    cylinder.status = "rented";
    cylinder.customer = input.customer;
    cylinder.location = input.customer;
    cylinder.depositStatus = input.depositStatus || "paid";
    return { fromStatus, toStatus: "rented" };
  },
  return(cylinder, input) {
    const fromStatus = cylinder.status;
    cylinder.status = "returned";
    cylinder.location = input.location || "待检区";
    cylinder.customer = null;
    cylinder.depositStatus = input.depositStatus || "refundable";
    return { fromStatus, toStatus: "returned" };
  },
  inspect(cylinder, input) {
    const fromStatus = cylinder.status;
    cylinder.status = "inspection";
    cylinder.location = input.location || "送检中";
    if (input.inspectionDue) cylinder.inspectionDue = input.inspectionDue;
    return { fromStatus, toStatus: "inspection" };
  },
  scrap(cylinder, input) {
    const fromStatus = cylinder.status;
    cylinder.status = "scrapped";
    cylinder.location = input.location || "报废区";
    return { fromStatus, toStatus: "scrapped" };
  },
  mark_pending_check(cylinder, input) {
    const fromStatus = cylinder.status;
    cylinder.status = "pending_check";
    cylinder.location = input.location || "待核查区";
    return { fromStatus, toStatus: "pending_check" };
  },
  clear_pending_check(cylinder, input) {
    const fromStatus = cylinder.status;
    cylinder.status = input.targetStatus || "in_stock";
    cylinder.location = input.location || "仓库";
    return { fromStatus, toStatus: input.targetStatus || "in_stock" };
  }
};

export function applyAction(cylinder, input) {
  if (!transitions[input.type]) {
    const err = new Error("unknown_action");
    err.statusCode = 400;
    throw err;
  }
  const { fromStatus, toStatus } = transitions[input.type](cylinder, input);
  const evt = makeEvent(input.type, input.note || input.type);
  cylinder.events.push(evt);
  addStatusHistory(cylinder, {
    fromStatus,
    toStatus,
    note: input.note || input.type,
    operator: input.operator || null,
    eventId: evt.id
  });
  return evt;
}

export function createCylinder(input) {
  const now = new Date().toISOString();
  const createEvt = makeEvent("create", "新建钢瓶");
  const cylinder = {
    id: input.id,
    gasType: input.gasType,
    capacity: input.capacity,
    inspectionDue: input.inspectionDue,
    location: input.location || "仓库",
    status: "in_stock",
    customer: null,
    depositStatus: "none",
    fills: [],
    events: [createEvt],
    statusHistory: [
      {
        id: `sh-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fromStatus: null,
        toStatus: "in_stock",
        at: now,
        note: "新建钢瓶",
        operator: input.operator || null,
        eventId: createEvt.id,
        extra: null
      }
    ]
  };
  return cylinder;
}

export function addFill(cylinder, input) {
  const fill = {
    id: `fill-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    filledAt: input.filledAt || new Date().toISOString().slice(0, 10),
    pressure: input.pressure,
    operator: input.operator
  };
  cylinder.fills.push(fill);
  const evt = makeEvent("fill", `充装${input.pressure || ""}`);
  cylinder.events.push(evt);
  return { fill, event: evt };
}

export function getLatestEvent(cylinder) {
  if (!Array.isArray(cylinder.events) || cylinder.events.length === 0) return null;
  const sorted = [...cylinder.events].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );
  return sorted[0];
}

export function daysUntil(dateText) {
  return Math.ceil((new Date(dateText).getTime() - Date.now()) / 86400000);
}

export function buildAlerts(cylinders, options = {}) {
  const inspectionDays = options.inspectionDays ?? 45;
  const longRentDays = options.longRentDays ?? 30;
  return cylinders.flatMap((cylinder) => {
    const items = [];
    if (daysUntil(cylinder.inspectionDue) <= inspectionDays) {
      items.push({
        type: "inspection_due",
        cylinderId: cylinder.id,
        due: cylinder.inspectionDue,
        daysLeft: daysUntil(cylinder.inspectionDue)
      });
    }
    const lastOutbound = [...cylinder.events].reverse().find((evt) => evt.type === "outbound");
    if (
      cylinder.status === "rented" &&
      lastOutbound &&
      (Date.now() - new Date(lastOutbound.at).getTime()) / 86400000 >= longRentDays
    ) {
      items.push({
        type: "long_rent",
        cylinderId: cylinder.id,
        customer: cylinder.customer,
        since: lastOutbound.at
      });
    }
    return items;
  });
}
