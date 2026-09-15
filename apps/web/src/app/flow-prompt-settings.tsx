import styles from './flow-editor.module.css';

export function ProfilePromptSettings(p: {
  name: string;
  prompts?: Record<string, string>;
  disabled: boolean;
  onChange?: (prompts: Record<string, string>) => void;
  onInline: (text: string) => void;
}) {
  if (!p.prompts)
    return <p>Reload with the latest daemon to edit profile prompts.</p>;
  const exists = Object.hasOwn(p.prompts, p.name);
  const safeName =
    /^[A-Za-z0-9._-]+$/.test(p.name) &&
    !['.', '..', '__proto__', 'constructor', 'prototype'].includes(p.name);
  if (!exists)
    return (
      <div className={styles.callout}>
        <p>
          {p.name
            ? `Profile prompt “${p.name}” does not exist.`
            : 'Enter a profile prompt name above.'}
        </p>
        <button
          disabled={p.disabled || !p.onChange || !safeName}
          onClick={() => p.onChange?.({ ...p.prompts, [p.name]: '' })}
        >
          Create profile prompt
        </button>
      </div>
    );
  const text = p.prompts[p.name];
  return (
    <>
      <label className={styles.field}>
        Profile prompt instructions
        <textarea
          rows={18}
          spellCheck={false}
          value={text}
          disabled={p.disabled || !p.onChange}
          onChange={(e) =>
            p.onChange?.({ ...p.prompts, [p.name]: e.target.value })
          }
        />
      </label>
      <p className={styles.description}>
        Save profile to apply these instructions to future runs. All nodes
        referencing “{p.name}” in this profile share these instructions.
      </p>
      <button disabled={p.disabled} onClick={() => p.onInline(text)}>
        Use inline copy
      </button>
      <p className={styles.description}>
        An inline copy can be customized independently and is included in flow
        exports.
      </p>
    </>
  );
}
