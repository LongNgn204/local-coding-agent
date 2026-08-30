import { useId } from "react";

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  error?: string;
  hint?: string;
  placeholder?: string;
  browse?: () => void;
  type?: string;
  onShowToggle?: () => void;
  showToggle?: boolean;
}

export function Field({ label, value, onChange, invalid, error, hint, placeholder, browse, type = "text", onShowToggle, showToggle }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className={`field${invalid ? " invalid" : ""}`}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="field-control">
        <input
          id={id}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          aria-describedby={hint || error ? helpId : undefined}
        />
        {showToggle && (
          <button type="button" className="button secondary compact" onClick={onShowToggle} aria-label={`${type === "password" ? "Show" : "Hide"} ${label}`}>
            {type === "password" ? "Show" : "Hide"}
          </button>
        )}
        {browse && <button type="button" className="button secondary compact" onClick={browse}>Browse</button>}
      </div>
      {(error || hint) && <span id={helpId} className={error ? "field-error" : "field-hint"}>{error || hint}</span>}
    </div>
  );
}

interface CheckProps {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  danger?: boolean;
  hint?: string;
}

export function Check({ label, checked, onChange, danger, hint }: CheckProps) {
  return (
    <label className={`check${danger ? " danger" : ""}`} title={hint}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  invalid?: boolean;
  error?: string;
  hint?: string;
}

export function SelectField({ label, value, options, onChange, invalid, error, hint }: SelectFieldProps) {
  const id = useId();
  return (
    <div className={`field${invalid ? " invalid" : ""}`}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="field-control">
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={invalid || undefined}>
          {options.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </div>
      {(error || hint) && <span className={error ? "field-error" : "field-hint"}>{error || hint}</span>}
    </div>
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  invalid?: boolean;
  error?: string;
  hint?: string;
}

export function NumberField({ label, value, onChange, invalid, error, hint }: NumberFieldProps) {
  const id = useId();
  return (
    <div className={`field${invalid ? " invalid" : ""}`}>
      <label className="field-label" htmlFor={id}>{label}</label>
      <div className="field-control">
        <input id={id} type="number" min={1} max={65535} value={value} onChange={(event) => onChange(Number.parseInt(event.target.value, 10) || 0)} aria-invalid={invalid || undefined} />
      </div>
      {(error || hint) && <span className={error ? "field-error" : "field-hint"}>{error || hint}</span>}
    </div>
  );
}

interface SectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function Section({ title, description, children, className = "" }: SectionProps) {
  return (
    <section className={`group ${className}`.trim()}>
      <div className="section-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      <div className="group-body">{children}</div>
    </section>
  );
}
