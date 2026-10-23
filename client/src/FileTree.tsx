import { useMemo, type CSSProperties } from "react";
import { buildTree, type TreeNode } from "./tree";

interface TreeProps {
  /** The open file's path. */
  selected: string | null;
  /** Folders the Developer has closed. Folders start open. */
  collapsed: ReadonlySet<string>;
  onToggle(folder: string): void;
  onOpen(path: string): void;
}

/** The Workspace's files as folders and files, folders first. Folders open and close, and choosing a file opens it. */
export function FileTree({ paths, ...props }: { paths: readonly string[] } & TreeProps) {
  const tree = useMemo(() => buildTree(paths), [paths]);
  return (
    <ul className="tree">
      {tree.map((node) => (
        <TreeItem key={node.path} node={node} depth={0} {...props} />
      ))}
    </ul>
  );
}

function TreeItem({ node, depth, ...props }: { node: TreeNode; depth: number } & TreeProps) {
  const indent = { "--depth": depth } as CSSProperties;

  if (node.kind === "file") {
    return (
      <li>
        <button
          type="button"
          className="tree-item tree-file"
          style={indent}
          title={node.path}
          aria-current={node.path === props.selected ? "true" : undefined}
          onClick={() => props.onOpen(node.path)}
        >
          <span className="tree-name">{node.name}</span>
        </button>
      </li>
    );
  }

  const open = !props.collapsed.has(node.path);
  return (
    <li>
      <button
        type="button"
        className="tree-item"
        style={indent}
        title={node.path}
        aria-expanded={open}
        onClick={() => props.onToggle(node.path)}
      >
        <span className="tree-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open && (
        <ul>
          {node.children.map((child) => (
            <TreeItem key={child.path} node={child} depth={depth + 1} {...props} />
          ))}
        </ul>
      )}
    </li>
  );
}
