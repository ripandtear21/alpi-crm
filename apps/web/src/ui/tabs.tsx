import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react'

export type TabItem = { id: string; label: ReactNode; content: ReactNode }

type TabsProps = {
  /** Доступное имя списка вкладок. */
  label: string
  tabs: TabItem[]
  defaultValue?: string
  onChange?: (id: string) => void
}

/**
 * Вкладки (шаблон WAI-ARIA «tabs», выбор следует за фокусом): в порядке Tab стоит только
 * выбранная вкладка, стрелки влево и вправо переключают по кругу, Home и End — на края.
 */
export function Tabs({ label, tabs, defaultValue, onChange }: TabsProps) {
  const [selected, setSelected] = useState(defaultValue ?? tabs[0]?.id)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const baseId = useId()
  const current = tabs.find((tab) => tab.id === selected) ?? tabs[0]

  function select(id: string) {
    setSelected(id)
    tabRefs.current.get(id)?.focus()
    onChange?.(id)
  }

  function onKeyDown(event: KeyboardEvent) {
    const index = tabs.findIndex((tab) => tab.id === current?.id)
    const targets: Record<string, number> = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index - 1 + tabs.length) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }
    const target = targets[event.key]
    const tab = target === undefined ? undefined : tabs[target]
    if (!tab) return
    event.preventDefault()
    select(tab.id)
  }

  return (
    <div className="ui-tabs">
      <div role="tablist" aria-label={label} className="ui-tabs__list" onKeyDown={onKeyDown}>
        {tabs.map((tab) => {
          const isSelected = tab.id === current?.id
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element)
                else tabRefs.current.delete(tab.id)
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel`}
              tabIndex={isSelected ? 0 : -1}
              className="ui-tab"
              onClick={() => select(tab.id)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      {current && (
        <div
          role="tabpanel"
          id={`${baseId}-panel`}
          aria-labelledby={`${baseId}-tab-${current.id}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: панель вкладки по шаблону WAI-ARIA доступна с Tab
          tabIndex={0}
          className="ui-tabs__panel"
        >
          {current.content}
        </div>
      )}
    </div>
  )
}
