# Fold&Go: Database Schema Documentation

This document outlines the unified database schema used by the .NET Core backend (PostgreSQL) and the Android Mobile application (Room DB).

---

## 1. Overview
The system uses a **Sync-Down Configuration / Sync-Up Transaction** model.
- **Configuration Tables:** Managed by the Web Admin, synced to Mobile.
- **Transaction Tables:** Created on Mobile, synced to the Server.

---

## 2. Configuration Tables (Sync-Down)

### `shops`
Stores the business details for each laundry branch.
| Column | Type | Description |
| :--- | :--- | :--- |
| `shopId` | `String` (PK) | Unique identifier for the shop |
| `name` | `String` | Registered name of the shop |
| `address` | `String` | Physical location |
| `mobileNumber` | `String` | Contact number for the branch |
| `ownerId` | `String` | ID of the shop owner |
| `pin` | `String` | 4-digit security PIN for mobile login |
| `settings` | `String` (JSON) | Shop-specific settings (e.g., currency, tax) |
| `createdAt` | `Long` | Timestamp of registration |

### `staff`
Stores operator and manager profiles.
| Column | Type | Description |
| :--- | :--- | :--- |
| `staffId` | `String` (PK) | Unique identifier |
| `shopId` | `String` (FK) | Reference to `shops.shopId` |
| `name` | `String` | Full name of the staff member |
| `role` | `String` | Role (e.g., "Operator", "Manager") |
| `isActive` | `Boolean` | Employment status |
| `createdAt` | `Long` | Timestamp of creation |

### `machine_categories`
Groupings for machines (e.g., "Industrial Washers").
| Column | Type | Description |
| :--- | :--- | :--- |
| `categoryId` | `String` (PK) | Unique identifier |
| `name` | `String` | Display name (e.g., "Stacked Dryers") |
| `iconName` | `String?` | Name of the icon asset |
| `colorHex` | `String?` | UI accent color for this category |

### `machines`
Physical hardware registry.
| Column | Type | Description |
| :--- | :--- | :--- |
| `machineId` | `String` (PK) | Unique identifier |
| `shopId` | `String` (FK) | Reference to `shops.shopId` |
| `name` | `String` | Machine name/number (e.g., "W-01") |
| `capacityKg` | `Double` | Maximum load capacity |
| `status` | `Enum` | `MachineStatus` (e.g., `IDLE`, `WASHING`) |
| `lastMaintenanceDate` | `Long` | Last service timestamp |
| `endTime` | `Long?` | Estimated finish time of current cycle |
| `cyclesCount` | `Int` | Total cycles performed (for maintenance tracking) |
| `assignedOrderId` | `String?` | ID of the order currently occupying the machine |

### `services`
The menu of services offered by the shop.
| Column | Type | Description |
| :--- | :--- | :--- |
| `serviceId` | `String` (PK) | Unique identifier |
| `shopId` | `String` (FK) | Reference to `shops.shopId` |
| `name` | `String` | Service name (e.g., "Wash & Dry") |
| `defaultQuantity` | `Double` | Default weight/unit for intake |
| `unit` | `String` | Measurement unit (e.g., "KG", "PCS") |
| `pricePerUnit` | `Double` | Unit price |
| `type` | `Enum` | `ServiceType` (`BUNDLE`, `PER_KG`) |

### `sms_subscriptions`
Stores SMS quota and plan details for a shop.
| Column | Type | Description |
| :--- | :--- | :--- |
| `shopId` | `String` (PK) | Reference to `shops.shopId` |
| `planName` | `String` | Name of the SMS plan |
| `allocatedSms` | `Int` | Total SMS allowed in cycle |
| `usedSms` | `Int` | SMS used in current cycle |
| `billingCycleStart` | `Long` | Timestamp |
| `billingCycleEnd` | `Long` | Timestamp |
| `isActive` | `Boolean` | Subscription status |

---

## 3. Transaction Tables (Sync-Up)

### `orders`
Primary table for customer transactions.
| Column | Type | Description |
| :--- | :--- | :--- |
| `orderId` | `String` (PK) | Unique identifier |
| `shopId` | `String` (FK) | Reference to `shops.shopId` |
| `customerId` | `String` | Identifier for the customer |
| `customerName` | `String` | Display name of the customer |
| `customerPhone` | `String` | Phone number for SMS notifications |
| `customerAddress` | `String` | Address for delivery orders |
| `orderNumber` | `String` | Human-readable receipt ID (e.g., FG-1001) |
| `itemsJson` | `String` (JSON) | List of `ServiceItem` objects |
| `totalAmount` | `Double` | Final price inclusive of fees |
| `deliveryFee` | `Double` | Fee for delivery service |
| `paidAmount` | `Double` | Total amount collected |
| `changeDue` | `Double` | Change returned to customer |
| `status` | `Enum` | `OrderStatus` |
| `deliveryMethod` | `Enum` | `PICKUP`, `DELIVERY` |
| `paymentStatus` | `Enum` | `PENDING`, `PAID`, `PARTIAL` |
| `intakePhotosJson` | `String?` (JSON) | List of local image paths |
| `machineId` | `String?` (FK) | Currently assigned machine |
| `staffId` | `String` (FK) | Operator who took the order |
| `staffName` | `String` | Name of the staff member |
| `createdAt` | `Long` | Timestamp of intake |
| `updatedAt` | `Long` | Timestamp of last status change |
| `isSynced` | `Boolean` | Internal flag for Mobile Sync outbox |

### `customers`
Customer directory for faster intake and CRM.
| Column | Type | Description |
| :--- | :--- | :--- |
| `customerId` | `String` (PK) | Unique identifier |
| `name` | `String` | Full name |
| `phone` | `String` | Primary contact |
| `address` | `String` | Default delivery address |
| `createdAt` | `Long` | Timestamp |
| `updatedAt` | `Long` | Timestamp |

### `order_batches`
Tracks individual processing units within an order (e.g., a specific wash load).
| Column | Type | Description |
| :--- | :--- | :--- |
| `batchId` | `String` (PK) | Unique identifier |
| `orderId` | `String` (FK) | Reference to `orders.orderId` |
| `machineId` | `String?` (FK) | Machine processing this batch |
| `weightKg` | `Double` | Weight of this specific batch |
| `status` | `Enum` | `BatchStatus` |
| `serviceType` | `Enum` | `ServiceType` |
| `startTime` | `Long` | Start timestamp |
| `endTime` | `Long?` | Completion timestamp |

### `sms_transaction_logs`
Audit log for sent SMS notifications.
| Column | Type | Description |
| :--- | :--- | :--- |
| `logId` | `Long` (PK) | Auto-incrementing ID |
| `jobOrderId` | `String` | Associated order ID |
| `recipientNumber` | `String` | Phone number sent to |
| `messageBody` | `String` | Content of the message |
| `segmentsCharged` | `Int` | Number of SMS units consumed |
| `timestamp` | `Long` | Sent timestamp |
| `apiResponseId` | `String?` | Provider tracking ID |

### `sync_outbox` (Mobile Only)
Stores pending operations to be pushed to the server.
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `Long` (PK) | Auto-incrementing ID |
| `entityType` | `String` | e.g., "ORDER", "MACHINE_STATUS" |
| `entityId` | `String` | ID of the modified entity |
| `operation` | `String` | `CREATE`, `UPDATE`, `DELETE` |
| `payloadJson` | `String` | Full JSON object for the server update |
| `createdAt` | `Long` | Timestamp of the local change |

---

## 4. Enums & Constants

### OrderStatus
`PENDING`, `QUEUED`, `WASHING`, `WASHED`, `DRYING`, `DRIED`, `IRONING`, `IRONED`, `FOLDING`, `READY`, `DELIVERED`

### MachineStatus
`IDLE`, `QUEUED`, `WASHING`, `DRYING`, `IRONING`, `FOLDING`, `READY`, `OUT_OF_ORDER`

### MachineType
`WASHER`, `DRYER`, `WASHER_DRYER`, `IRON`, `STEAMER`

### ServiceType
`BUNDLE`, `PER_KG`

### ServiceScope
`ALL`, `WASH_ONLY`, `DRY_ONLY`, `FOLD_ONLY`

### BatchStatus
`QUEUED`, `WASHING`, `DRYING`, `FOLDING`, `READY`

### PaymentStatus
`PENDING`, `PAID`, `PARTIAL`

### DeliveryMethod
`PICKUP`, `DELIVERY`