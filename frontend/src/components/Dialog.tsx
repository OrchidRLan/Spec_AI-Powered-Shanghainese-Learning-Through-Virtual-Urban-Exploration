import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
export default function Dialog({ title, children, onClose, closeLabel, className = '' }: { title: string; children: ReactNode; onClose: () => void; closeLabel: string; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    const cancel = (event: Event) => { event.preventDefault(); close.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`dialog ${className}`} aria-labelledby="dialog-title" onClick={e => { if(e.target === ref.current) onClose(); }}>
    <div className="dialog-inner"><header className="dialog-header"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label={closeLabel}><X size={22}/></button></header>{children}</div>
  </dialog>;
}
