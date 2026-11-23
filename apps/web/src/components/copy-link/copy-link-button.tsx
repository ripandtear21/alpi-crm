import { useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button.tsx'
import { useToast } from '../../ui/toast.tsx'

/**
 * «Скопіювати посилання» в карточках сделки, контакта и организации (тикет crm-deals/15):
 * адрес текущего экрана — он уже с кодом проекта (`/p/<код>/deals/<id>`). Буфер обмена
 * недоступен (страница не по https, запрет браузера) — уведомление показывает ссылку целиком,
 * чтобы её можно было скопировать руками.
 */
export function CopyLinkButton() {
  const { t } = useTranslation('layout')
  const toast = useToast()
  const path = useRouterState({ select: (state) => state.location.href })

  const copy = async () => {
    const link = new URL(path, window.location.origin).href
    try {
      if (!navigator.clipboard) throw new Error('Буфер обмена недоступен')
      await navigator.clipboard.writeText(link)
      toast(t('copyLink.done'))
    } catch {
      toast(t('copyLink.failed', { link }), { tone: 'error' })
    }
  }

  return (
    <Button size="sm" onClick={() => void copy()}>
      {t('copyLink.button')}
    </Button>
  )
}
