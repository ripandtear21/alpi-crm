// Участники и команды проекта в ответах API (тикет crm-foundation/06): `/members`, `/teams`.

/** Участник проекта (`GET /members`). */
export interface MemberSummary {
  userId: string
  email: string
  name: string
  roleId: string
  /** Команда участника; null — ни в одной команде. */
  teamId: string | null
  /** «Принимает новые сделки». */
  acceptsNewDeals: boolean
  /** Участие отключено: пользователь не входит в проект. */
  disabled: boolean
}

/** Ответ `POST /members/new`: участник и временный пароль новой учётной записи. */
export interface CreatedMemberResponse {
  member: MemberSummary
  /** Показывается один раз: сервер его не хранит в открытом виде и не пишет в журнал. */
  temporaryPassword: string
}

/** Команда проекта (`GET /teams`). */
export interface TeamSummary {
  id: string
  name: string
  /** Тимлид: участник этой команды. */
  leadUserId: string
  /** Участники команды, тимлид среди них. */
  memberUserIds: string[]
}

/** Коды ошибок API участников и команд (вдобавок к кодам ролей: роль назначается там же). */
export type MembersErrorCode =
  | 'INVALID_MEMBER'
  | 'USER_NOT_FOUND'
  /** Пользователь уже участник проекта (в том числе отключённый). */
  | 'MEMBER_EXISTS'
  /** Учётная запись с таким email уже есть: добавьте существующего пользователя. */
  | 'EMAIL_TAKEN'
  /** У участника есть открытые сделки: сначала передайте их. */
  | 'HAS_OPEN_DEALS'
  /** Участник ведёт команду: сначала назначьте команде другого тимлида. */
  | 'MEMBER_IS_TEAM_LEAD'
  | 'INVALID_TEAM'
  | 'TEAM_NOT_FOUND'
  | 'TEAM_NAME_TAKEN'
  /** Пользователь уже ведёт другую команду. */
  | 'LEADS_OTHER_TEAM'
  /** Тимлидом назначен отключённый участник. */
  | 'TEAM_LEAD_DISABLED'
