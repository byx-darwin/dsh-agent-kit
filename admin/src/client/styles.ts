/**
 * 设置页样式。dsh 前端模块只能交付一个 JS 文件，所以样式以字符串形式在 apply() 时注入一次、卸载时移除。
 * 视觉对齐 dsh 自带的插件设置卡片（ui-settings-plugins 的 PluginCard / fields）：颜色一律取宿主的
 * `--dsw-alias-*` 设计变量，随浅色 / 深色主题切换；不依赖 rc.2 之后才有的 primitives 组件。
 */
export const STYLE_ID = 'agent-kit-settings-style'

export const CSS = `
.agent-kit-settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  line-height: 1.5;
}
.agent-kit-settings h2 { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; }
.agent-kit-meta { margin: 0; color: var(--dsw-alias-label-tertiary); }
.agent-kit-meta > span + span::before { content: '·'; margin: 0 6px; }
.agent-kit-banner {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label);
}
.agent-kit-cards { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; }

.agent-kit-card {
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-3);
  transition: border-color .16s, background .16s;
}
.agent-kit-card:hover { border-color: var(--dsw-alias-label-dimmed); }
.agent-kit-card[data-enabled='true'] { background: var(--dsw-alias-bg-layer-2); }

.agent-kit-card-head { display: flex; align-items: center; gap: 12px; padding: 14px 16px; }
.agent-kit-card-title { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.agent-kit-card-title h3 { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.4; }
.agent-kit-detail { margin: 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }

.agent-kit-tag {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.agent-kit-tag::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.agent-kit-tag[data-tone='ok'] { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
.agent-kit-tag[data-tone='warn'] { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
.agent-kit-tag[data-tone='error'] { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }

.agent-kit-switch {
  flex: none;
  position: relative;
  width: 36px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l4);
  cursor: pointer;
  transition: background .16s;
}
.agent-kit-switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: 0 1px 2px rgba(0, 0, 0, .2);
  transition: transform .16s;
}
.agent-kit-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.agent-kit-switch[aria-checked='true']::after { transform: translateX(16px); }
.agent-kit-switch:disabled { opacity: .4; cursor: default; }
.agent-kit-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }

.agent-kit-sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.agent-kit-card-body { margin: 0 16px; padding-bottom: 4px; border-top: 0.5px solid var(--dsw-alias-border-l2); }
.agent-kit-card-body > * + * { border-top: 0.5px solid var(--dsw-alias-border-l2); }

.agent-kit-checks { list-style: none; margin: 0; padding: 10px 0; display: flex; flex-direction: column; gap: 6px; }
.agent-kit-checks li { display: flex; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.agent-kit-checks li::before {
  content: ''; flex: none; width: 6px; height: 6px; margin-top: 6px; border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
}
.agent-kit-checks li[data-status='fail']::before { background: var(--dsw-alias-state-error-primary); }
.agent-kit-checks .agent-kit-fix { color: var(--dsw-alias-label-tertiary); }

.agent-kit-fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0 16px;
  padding: 4px 0;
}
.agent-kit-field { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; min-width: 0; }
.agent-kit-field > label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.agent-kit-field small, .agent-kit-hint {
  margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary);
}
.agent-kit-field:has(> input[type='checkbox']) {
  flex-direction: row; align-items: center; justify-content: space-between; gap: 12px;
}
.agent-kit-field:has(> input[type='checkbox']) small { flex-basis: 100%; }

.agent-kit-settings input:not([type='checkbox']),
.agent-kit-settings select,
.agent-kit-settings textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 34px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-3);
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.agent-kit-settings textarea { padding: 7px 12px; min-height: 60px; resize: vertical; }
.agent-kit-settings select { appearance: auto; }
.agent-kit-settings input:focus-visible,
.agent-kit-settings select:focus-visible,
.agent-kit-settings textarea:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.agent-kit-settings input:disabled,
.agent-kit-settings select:disabled,
.agent-kit-settings textarea:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.agent-kit-settings input[type='checkbox'] {
  width: 16px; height: 16px; margin: 0; accent-color: var(--dsw-alias-brand-primary);
}

.agent-kit-reload { padding-top: 10px; }
.agent-kit-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 12px 0 10px; }
.agent-kit-footer .agent-kit-hint { flex: 1; min-width: 0; }
.agent-kit-message { flex: 1; min-width: 0; margin: 0; font-size: 12px; white-space: pre-line; color: var(--dsw-alias-label-secondary); }
.agent-kit-message[data-tone='error'], .agent-kit-settings [role='alert'] { color: var(--dsw-alias-label-error); }

.agent-kit-btn {
  flex: none;
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  padding: 5px 14px;
  background: none;
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.agent-kit-btn:hover:not(:disabled) { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.agent-kit-btn[data-variant='primary'] {
  border-color: transparent;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-bg-layer-3);
}
.agent-kit-btn[data-variant='primary']:hover:not(:disabled) { color: var(--dsw-alias-bg-layer-3); opacity: .88; }
.agent-kit-btn:disabled { opacity: .4; cursor: default; }
.agent-kit-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }

.agent-kit-secrets { padding: 10px 0; display: flex; flex-direction: column; gap: 10px; }
.agent-kit-secrets h4 { margin: 0; font-size: 13px; font-weight: 600; }
.agent-kit-secret { display: flex; flex-direction: column; gap: 6px; }
.agent-kit-secret-head { display: flex; align-items: center; gap: 8px; }
.agent-kit-secret-head label { flex: 1; min-width: 0; font-weight: 500; }
.agent-kit-secret-row { display: flex; gap: 8px; }
.agent-kit-secret-row input, .agent-kit-secret-row select { flex: 1; min-width: 0; }
.agent-kit-secret-row select { flex: 0 0 auto; width: auto; max-width: 240px; }
.agent-kit-auth-title { flex: 1; min-width: 0; font-weight: 600; }
.agent-kit-actions { justify-content: flex-end; }
a.agent-kit-btn { text-decoration: none; display: inline-flex; align-items: center; }
.agent-kit-login { display: flex; flex-direction: column; gap: 8px; }
.agent-kit-login-code {
  align-self: flex-start;
  padding: 6px 14px;
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: .12em;
}
`
