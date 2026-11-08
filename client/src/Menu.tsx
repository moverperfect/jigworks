import { useId, type ReactNode, type Ref } from "react";

/**
 * The bar's menu: who's signed in, then the page's own items, if any. It's a
 * popover, so the browser closes it on Escape or a click elsewhere.
 */
export function Menu({ account, children, ref }: { account: ReactNode; children?: ReactNode; ref?: Ref<HTMLDivElement> }) {
  const menuId = useId();
  return (
    <>
      <button type="button" className="button button-small menu-button" popoverTarget={menuId}>
        Menu
      </button>
      <div ref={ref} id={menuId} popover="auto" className="menu">
        <p className="menu-account">{account}</p>
        {children && <ul className="menu-list">{children}</ul>}
      </div>
    </>
  );
}
