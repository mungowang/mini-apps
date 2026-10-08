import * as React from "react";
import { AnimatePresence, motion } from "motion/react";

import { TaskDetail } from "./detail";
import { Rhythm } from "./rhythm";
import { useStore } from "./store";

const EASE = [0.22, 1, 0.36, 1] as const;

function useReducedMotion(): boolean {
  const [reduce, setReduce] = React.useState(false);
  React.useEffect(function () {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    function apply() {
      setReduce(mq.matches);
    }
    apply();
    mq.addEventListener("change", apply);
    return function () {
      mq.removeEventListener("change", apply);
    };
  }, []);
  return reduce;
}

export function ContextRail(props: { closable: boolean }) {
  const { selectedId } = useStore();
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : { duration: 0.36, ease: EASE };

  return (
    <div className="h-full w-[400px] shrink-0 border-l border-border bg-background">
      <AnimatePresence mode="wait" initial={false}>
        {selectedId ? (
          <motion.div
            key="detail"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -16 }}
            transition={transition}
            className="h-full"
          >
            <TaskDetail />
          </motion.div>
        ) : (
          <motion.div
            key="rhythm"
            initial={{ opacity: 0, x: -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            transition={transition}
            className="h-full"
          >
            <Rhythm closable={props.closable} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
