import { motion } from "framer-motion";
import { Outlet, useRouterState } from "@tanstack/react-router";

/**
 * Snappy route transition: a lightweight fade (no blur, no layout-shift),
 * mounted without AnimatePresence so the new page renders immediately
 * instead of waiting for the previous page to exit. This eliminates the
 * perceived "lag" when switching between superuser / admin / director /
 * manager panels and when opening dropdown destinations like
 * /superuser/admins or /superuser/history.
 */
export function PageTransition() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <motion.div
      key={pathname}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      style={{ willChange: "opacity" }}
    >
      <Outlet />
    </motion.div>
  );
}
