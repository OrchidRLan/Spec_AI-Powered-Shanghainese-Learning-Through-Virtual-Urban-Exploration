import './Toggle.css';

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  showLabel?: boolean;
  className?: string;
};

/** The touch target and the visible track have separate dimensions. */
export default function Toggle({ checked, onChange, label, disabled = false, showLabel = false, className = '' }: Props) {
  return <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={`preference-switch ${className}`.trim()}
    onClick={() => onChange(!checked)}
  >
    <span className="preference-switch-track" aria-hidden="true"><span className="preference-switch-thumb"/></span>
    {showLabel && <span className="preference-switch-label">{label}</span>}
  </button>;
}
