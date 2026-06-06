import { ConfigNav } from './config-nav';

// config-header.tsx — the shared Config-area chrome: the "Configuration" title + description + the
// sub-nav tab strip. Rendered by the Config layout AND by the Warehouses pages (which live at the
// top-level /warehouses route but belong to Config) so they're pixel-identical to every other config
// page — same header, same tab strip, same spacing. The signed-in admin's email feeds the nav chip.
export function ConfigHeader({ adminEmail }: { adminEmail: string }) {
  return (
    <>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Configuration</h1>
        <p className="text-sm text-muted-foreground">
          Admin console — manage the user directory, the tag library, warehouses, the permission
          matrix, and the security audit trail. Admin-only; read live from Mongo.
        </p>
      </header>
      <ConfigNav adminEmail={adminEmail} />
    </>
  );
}

export default ConfigHeader;
