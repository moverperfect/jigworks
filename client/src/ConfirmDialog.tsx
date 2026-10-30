import { useEffect, useId, useRef, type FormEvent, type ReactNode } from "react";

/** Asks before something that can't be undone. Closing it any other way cancels. */
export function ConfirmDialog({
  title,
  confirm,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  /** The confirming button's text. */
  confirm: string;
  /** What will happen. */
  children: ReactNode;
  onConfirm(): void;
  onClose(): void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    // StrictMode runs this twice in development, so don't open it twice.
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    dialog.current?.close();
    onConfirm();
  }

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      onClose={onClose}
    >
      <form className="form" onSubmit={submit}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`}>{children}</p>
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            {confirm}
          </button>
        </div>
      </form>
    </dialog>
  );
}
