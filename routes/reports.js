import { send } from "../store/common.js";
import { loadCylinders } from "../store/cylinders.js";

function daysUntil(dateText) {
  return Math.ceil((new Date(dateText).getTime() - Date.now()) / 86400000);
}

export async function handleReports(req, res, url) {
  if (req.method === "GET" && url.pathname === "/reports/alerts") {
    const inspectionDays = Number(url.searchParams.get("inspectionDays") || 45);
    const longRentDays = Number(url.searchParams.get("longRentDays") || 30);
    const cylinders = await loadCylinders();
    const alerts = cylinders.flatMap((cylinder) => {
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
    return send(res, 200, alerts);
  }

  return null;
}
