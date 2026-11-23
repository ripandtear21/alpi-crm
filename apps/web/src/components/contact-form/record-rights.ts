import { can, type ProjectAccess } from '@alpi/shared'

// Что пользователь может сделать в карточках контакта и организации — чтобы не показывать
// кнопки и поля без права (тикет crm-deals/14). Решает всё равно сервер
// (apps/api/src/contacts/contacts.ts, apps/api/src/organizations/organizations.ts).
//
// shortcut: охват изменения контактов не проверяется — «свой» контакт определяют его сделки и
// создатель, а этого клиент не знает; переделать, когда API скажет, в охвате ли запись. Пока
// кнопка видна при праве, а лишнее изменение сервер отклонит ответом 403.

export interface RecordRights {
  contactCreate: boolean
  contactEdit: boolean
  contactDelete: boolean
  organizationCreate: boolean
  organizationEdit: boolean
  organizationDelete: boolean
  dealCreate: boolean
}

export function recordRights({ permissions }: ProjectAccess): RecordRights {
  return {
    contactCreate: can(permissions, 'contacts', 'create'),
    contactEdit: can(permissions, 'contacts', 'edit'),
    contactDelete: can(permissions, 'contacts', 'delete'),
    organizationCreate: can(permissions, 'organizations', 'create'),
    organizationEdit: can(permissions, 'organizations', 'edit'),
    organizationDelete: can(permissions, 'organizations', 'delete'),
    dealCreate: can(permissions, 'deals', 'create'),
  }
}
