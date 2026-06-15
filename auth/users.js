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
  ORDER_RETURN: "order:return",
  INSPECTION_GENERATE: "inspection:generate",
  INSPECTION_SEND: "inspection:send",
  INSPECTION_INSPECT: "inspection:inspect",
  INSPECTION_RESTOCK: "inspection:restock",
  INSPECTION_POSTPONE: "inspection:postpone",
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
    PERMISSIONS.ORDER_RETURN,
    PERMISSIONS.INSPECTION_RESTOCK,
    PERMISSIONS.INVENTORY_CREATE,
    PERMISSIONS.INVENTORY_SCAN,
    PERMISSIONS.INVENTORY_COMPLETE
  ],
  [ROLES.SALES]: [
    PERMISSIONS.QUERY,
    PERMISSIONS.CUSTOMER_CREATE,
    PERMISSIONS.ORDER_CREATE,
    PERMISSIONS.ORDER_RETURN,
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
    PERMISSIONS.INSPECTION_POSTPONE,
    PERMISSIONS.INVENTORY_CREATE,
    PERMISSIONS.INVENTORY_SCAN,
    PERMISSIONS.INVENTORY_COMPLETE,
    PERMISSIONS.INVENTORY_CONFIRM
  ]
};

export const PERMISSION_META = {
  [PERMISSIONS.CYLINDER_CREATE]: {
    label: "新建钢瓶",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders"]
  },
  [PERMISSIONS.CYLINDER_BULK]: {
    label: "批量导入钢瓶",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders/bulk"]
  },
  [PERMISSIONS.CYLINDER_INBOUND]: {
    label: "钢瓶入库",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders/:id/actions (type=inbound/clear_pending_check)"]
  },
  [PERMISSIONS.CYLINDER_OUTBOUND]: {
    label: "钢瓶出库",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders/:id/actions (type=outbound)"]
  },
  [PERMISSIONS.CYLINDER_RETURN]: {
    label: "钢瓶归还",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders/:id/actions (type=return)"]
  },
  [PERMISSIONS.CYLINDER_INSPECT]: {
    label: "钢瓶送检",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders/:id/actions (type=inspect)"]
  },
  [PERMISSIONS.CYLINDER_SCRAP]: {
    label: "钢瓶报废与待核查标记",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders/:id/actions (type=scrap/mark_pending_check)"]
  },
  [PERMISSIONS.CYLINDER_FILL]: {
    label: "钢瓶充装",
    category: "钢瓶管理",
    endpoints: ["POST /cylinders/:id/fills"]
  },
  [PERMISSIONS.CUSTOMER_CREATE]: {
    label: "新建客户",
    category: "客户管理",
    endpoints: ["POST /customers"]
  },
  [PERMISSIONS.ORDER_CREATE]: {
    label: "创建租瓶订单",
    category: "订单管理",
    endpoints: ["POST /rental-orders"]
  },
  [PERMISSIONS.ORDER_RETURN]: {
    label: "订单归还钢瓶",
    category: "订单管理",
    endpoints: ["POST /rental-orders/:id/return"]
  },
  [PERMISSIONS.INSPECTION_GENERATE]: {
    label: "生成检验任务",
    category: "检验管理",
    endpoints: ["POST /inspection-tasks/generate"]
  },
  [PERMISSIONS.INSPECTION_SEND]: {
    label: "送检",
    category: "检验管理",
    endpoints: ["POST /inspection-tasks/:id/send"]
  },
  [PERMISSIONS.INSPECTION_INSPECT]: {
    label: "录入检验结果",
    category: "检验管理",
    endpoints: ["POST /inspection-tasks/:id/inspect"]
  },
  [PERMISSIONS.INSPECTION_RESTOCK]: {
    label: "检验回库",
    category: "检验管理",
    endpoints: ["POST /inspection-tasks/:id/restock"]
  },
  [PERMISSIONS.INSPECTION_POSTPONE]: {
    label: "延期检验",
    category: "检验管理",
    endpoints: ["POST /inspection-tasks/:id/postpone"]
  },
  [PERMISSIONS.INVENTORY_CREATE]: {
    label: "创建盘点单",
    category: "盘点管理",
    endpoints: ["POST /inventory-checks"]
  },
  [PERMISSIONS.INVENTORY_SCAN]: {
    label: "盘点扫描与开始",
    category: "盘点管理",
    endpoints: ["POST /inventory-checks/:id/start", "POST /inventory-checks/:id/scan"]
  },
  [PERMISSIONS.INVENTORY_COMPLETE]: {
    label: "完成盘点",
    category: "盘点管理",
    endpoints: ["POST /inventory-checks/:id/complete"]
  },
  [PERMISSIONS.INVENTORY_CONFIRM]: {
    label: "确认盘点",
    category: "盘点管理",
    endpoints: ["POST /inventory-checks/:id/confirm"]
  },
  [PERMISSIONS.QUERY]: {
    label: "数据查询与合规报表",
    category: "数据查询",
    endpoints: ["POST /compliance-reports", "POST /compliance-reports/:id/retry"]
  }
};

export function buildPermissionMatrix(roleFilter) {
  const matrix = Object.values(PERMISSIONS).map((permKey) => {
    const meta = PERMISSION_META[permKey] || { label: permKey, category: "未分类", endpoints: [] };
    const rolesWithPermission = Object.entries(ROLE_PERMISSIONS)
      .filter(([, perms]) => perms.includes(permKey))
      .map(([role]) => role);
    return {
      key: permKey,
      label: meta.label,
      category: meta.category,
      endpoints: meta.endpoints,
      roles: rolesWithPermission
    };
  });
  if (roleFilter) {
    return matrix.filter((entry) => entry.roles.includes(roleFilter));
  }
  return matrix;
}

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
