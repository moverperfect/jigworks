// PROTOTYPE, throwaway: a stand-in for the file tree and editor, which every variant keeps behind an escape hatch.
import { codeFiles } from "./simulation";

export function CodePeek({ onClose }: { onClose(): void }) {
  return (
    <div className="proto-code">
      <div className="proto-code-header">
        <strong>The code</strong>
        <span className="muted">For developers. The file tree, editor, Check and logs from today's Workspace page live here.</span>
        <button type="button" className="button button-small" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="proto-code-files">
        {codeFiles.map((path) => (
          <li key={path}>
            <code>{path}</code>
          </li>
        ))}
      </ul>
      <p className="muted proto-code-note">Also here: Download a copy (zip), and Delete this app.</p>
    </div>
  );
}
