import { createHash, randomBytes } from "node:crypto";

export const ROLES = {
  ADMIN: "admin",
  WAREHOUSE: "warehouse",
  SALES: "sales",
  QC: "qc"
};

export const ROLE_LABELS = {
  [ROLES.ADMIN]: "管理员",
  [ROLES.WAREHOUSE]: "仓库",
  [ROLES.SALES]: "销售",
  [ROLES.QC]: "质检"
};

export const PERMISSIONS = {
  CYLINDER_CREATE: "cylinder:create",
  CYLINDER_BULK: "cylinder:bulk",
  CYLINDER_INBOUND: "cylinder:inbound",
  CYLINDER_OUTBOUND: "cylinder:outbound",
  CYLINDER_RETURN: "cylinder:return",
  CYLINDER_INSPECT: "cylinder:inspect",
  CYLINDER_SCRAP: "cylinder:scrap",
  CYLINDER_FILL: "cylinder:fill",
  CUSTOMER_CREATE: "customer:create",
  ORDER_CREATE: "order:create",
  INSPECTION_GENERATE: "inspection:generate",
  INSPECTION_SEND: "inspection:send",
  INSPECTION_INSPECT: "inspection:inspect",
  INSPECTION_RESTOCK: "inspection:restock",
  INVENTORY_CREATE: "inventory:create",
  INVENTORY_SCAN: "inventory:scan",
  INVENTORY_COMPLETE: "inventory:complete",
  INVENTORY_CONFIRM: "inventory:confirm",
  QUERY: "query"
};

export const ROLE_PERMISSIONS = {
  [ROLES.ADMIN]: Object.values(PERMISSIONS),
  [ROLES.WAREHOUSE]: [
    PERMISSIONS.QUERY,
    PERMISSIONS.CYLINDER_CREATE,
    PERMISSIONS.CYLINDER_BULK,
    PERMISSIONS.CYLINDER_INBOUND,
    PERMISSIONS.CYLINDER_OUTBOUND,
    PERMISSIONS.CYLINDER_RETURN,
    PERMISSIONS.CYLINDER_FILL,
    PERMISSIONS.ORDER_CREATE,
    PERMISSIONS.INSPECTION_RESTOCK,
    PERMISSIONS.INVENTORY_CREATE,
    PERMISSIONS.INVENTORY_SCAN,
    PERMISSIONS.INVENTORY_COMPLETE
  ],
  [ROLES.SALES]: [
    PERMISSIONS.QUERY,
    PERMISSIONS.CUSTOMER_CREATE,
    PERMISSIONS.ORDER_CREATE,
    PERMISSIONS.CYLINDER_OUTBOUND,
    PERMISSIONS.CYLINDER_RETURN
  ],
  [ROLES.QC]: [
    PERMISSIONS.QUERY,
    PERMISSIONS.CYLINDER_INSPECT,
    PERMISSIONS.CYLINDER_SCRAP,
    PERMISSIONS.INSPECTION_GENERATE,
    PERMISSIONS.INSPECTION_SEND,
    PERMISSIONS.INSPECTION_INSPECT,
    PERMISSIONS.INSPECTION_RESTOCK,
    PERMISSIONS.INVENTORY_CREATE,
    PERMISSIONS.INVENTORY_SCAN,
    PERMISSIONS.INVENTORY_COMPLETE,
    PERMISSIONS.INVENTORY_CONFIRM
  ]
};

export function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes(permission);
}

export function hashPassword(password) {
  return createHash("sha256").update(password).digest("hex");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

export const DEFAULT_USERS = [
  {
    id: "user-admin",
    username: "admin",
    password: hashPassword("admin123"),
    role: ROLES.ADMIN,
    name: "系统管理员",
    createdAt: new Date().toISOString()
  },
  {
    id: "user-warehouse",
    username: "warehouse",
    password: hashPassword("warehouse123"),
    role: ROLES.WAREHOUSE,
    name: "仓库管理员",
    createdAt: new Date().toISOString()
  },
  {
    id: "user-sales",
    username: "sales",
    password: hashPassword("sales123"),
    role: ROLES.SALES,
    name: "销售专员",
    createdAt: new Date().toISOString()
  },
  {
    id: "user-qc",
    username: "qc",
    password: hashPassword("qc123"),
    role: ROLES.QC,
    name: "质检专员",
    createdAt: new Date().toISOString()
  }
];
