import { loadCylinders } from "./cylinders.js";
import { loadCustomers } from "./customers.js";

function flattenEvents(cylinders, customerMap) {
  const events = [];
  for (const cylinder of cylinders) {
    if (!Array.isArray(cylinder.events)) continue;
    for (const evt of cylinder.events) {
      const customerId = cylinder.customer || null;
      const customerName = customerId && customerMap
        ? customerMap.get(customerId)?.name || null
        : null;
      events.push({
        id: evt.id,
        type: evt.type,
        at: evt.at,
        note: evt.note || "",
        cylinderId: cylinder.id,
        gasType: cylinder.gasType,
        capacity: cylinder.capacity,
        customerId,
        customerName
      });
    }
  }
  return events;
}

function sortEvents(events, sortBy = "at", order = "desc") {
  const sorted = [...events].sort((a, b) => {
    let cmp = 0;
    if (sortBy === "at") {
      cmp = new Date(a.at).getTime() - new Date(b.at).getTime();
    } else if (sortBy === "type") {
      cmp = a.type.localeCompare(b.type);
    } else if (sortBy === "cylinderId") {
      cmp = a.cylinderId.localeCompare(b.cylinderId);
    }
    if (cmp === 0) {
      cmp = a.id.localeCompare(b.id);
    }
    return order === "asc" ? cmp : -cmp;
  });
  return sorted;
}

function filterEvents(events, filters) {
  let result = events;

  if (filters.cylinderId) {
    const kw = filters.cylinderId.toLowerCase();
    result = result.filter((e) => e.cylinderId.toLowerCase().includes(kw));
  }

  if (filters.type) {
    const types = filters.type.split(",").map((t) => t.trim()).filter(Boolean);
    if (types.length > 0) {
      result = result.filter((e) => types.includes(e.type));
    }
  }

  if (filters.startAt) {
    const start = new Date(filters.startAt).getTime();
    if (!isNaN(start)) {
      result = result.filter((e) => new Date(e.at).getTime() >= start);
    }
  }

  if (filters.endAt) {
    const end = new Date(filters.endAt).getTime();
    if (!isNaN(end)) {
      result = result.filter((e) => new Date(e.at).getTime() <= end);
    }
  }

  if (filters.customer) {
    const kw = filters.customer.toLowerCase();
    result = result.filter((e) => {
      if (!e.customerId && !e.customerName) return false;
      return (
        (e.customerId && e.customerId.toLowerCase().includes(kw)) ||
        (e.customerName && e.customerName.toLowerCase().includes(kw))
      );
    });
  }

  if (filters.note) {
    const kw = filters.note.toLowerCase();
    result = result.filter((e) => e.note.toLowerCase().includes(kw));
  }

  return result;
}

function paginate(events, page, pageSize) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const totalCount = events.length;
  const totalPages = Math.ceil(totalCount / ps) || 1;
  const start = (p - 1) * ps;
  const items = events.slice(start, start + ps);
  return {
    items,
    pagination: {
      page: p,
      pageSize: ps,
      totalCount,
      totalPages,
      hasNext: p < totalPages,
      hasPrev: p > 1
    }
  };
}

export async function queryEvents(filters = {}) {
  const cylinders = await loadCylinders();
  const customers = await loadCustomers();
  const customerMap = new Map(customers.map((c) => [c.id, c]));
  const allEvents = flattenEvents(cylinders, customerMap);
  const filtered = filterEvents(allEvents, filters);
  const sorted = sortEvents(filtered, filters.sortBy, filters.order);
  const { items, pagination } = paginate(sorted, filters.page, filters.pageSize);
  return { items, pagination };
}

export async function getCylinderTimeline(cylinderId, filters = {}) {
  const cylinders = await loadCylinders();
  const customers = await loadCustomers();
  const customerMap = new Map(customers.map((c) => [c.id, c]));
  const cylinder = cylinders.find((c) => c.id === cylinderId);
  if (!cylinder) return null;

  const allEvents = flattenEvents(cylinders, customerMap);
  const filtered = filterEvents(allEvents, { ...filters, cylinderId });
  const sorted = sortEvents(filtered, "at", "asc");

  return {
    cylinderId: cylinder.id,
    gasType: cylinder.gasType,
    capacity: cylinder.capacity,
    status: cylinder.status,
    location: cylinder.location,
    events: sorted
  };
}

export async function getEventTypes() {
  const cylinders = await loadCylinders();
  const types = new Set();
  for (const cylinder of cylinders) {
    if (Array.isArray(cylinder.events)) {
      for (const evt of cylinder.events) {
        types.add(evt.type);
      }
    }
  }
  return [...types].sort();
}
