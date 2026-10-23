export interface FolderNode {
  kind: "folder";
  name: string;
  /** From the Workspace's root, such as `src/routes`. */
  path: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: "file";
  name: string;
  path: string;
}

export type TreeNode = FolderNode | FileNode;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const byName = (a: TreeNode, b: TreeNode) =>
  a.kind !== b.kind ? (a.kind === "folder" ? -1 : 1) : collator.compare(a.name, b.name) || (a.name < b.name ? -1 : 1);

/** Folders and files from a list of file paths, folders first and then alphabetical at every level. */
export function buildTree(paths: readonly string[]): TreeNode[] {
  const root: FolderNode = { kind: "folder", name: "", path: "", children: [] };
  const folders = new Map<string, FolderNode>([["", root]]);

  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let parent = root;
    for (const [index, name] of parts.entries()) {
      const nodePath = parts.slice(0, index + 1).join("/");
      if (index === parts.length - 1) {
        parent.children.push({ kind: "file", name, path: nodePath });
        break;
      }
      let folder = folders.get(nodePath);
      if (!folder) {
        folder = { kind: "folder", name, path: nodePath, children: [] };
        folders.set(nodePath, folder);
        parent.children.push(folder);
      }
      parent = folder;
    }
  }

  for (const folder of folders.values()) folder.children.sort(byName);
  return root.children;
}

/** The folders that contain a path, outermost first: `a/b/c.ts` is in `a` and `a/b`. */
export function foldersOf(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}
