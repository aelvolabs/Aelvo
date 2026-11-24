"""Isolated behavioural probe: does `medium` mode actually execute a tool?

Uses the project's real kernel/filesystem/memory/orchestrator with a scripted
agent (no network, no API key). Writes only inside audit_artifacts/tmp_ws.
Read-only with respect to the implementation.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

WS = ROOT / "audit_artifacts" / "tmp_ws"
STATE = WS / ".aelvo"
STATE.mkdir(parents=True, exist_ok=True)
(WS / "backups").mkdir(exist_ok=True)
anchor = STATE / "anchor.md"
if not anchor.exists():
    anchor.write_text("---\nconstraints:\n  DEV_NAME: {value: Auditor, locked: true}\n---\n# audit\n", encoding="utf-8")
db_path = STATE / "memory.db"

TARGET = WS / "agent_medium_probe.txt"
if TARGET.exists():
    TARGET.unlink()


class ScriptedAgent:
    chat_only = False
    session_id = "probe"
    conversation_history: list = []

    def __init__(self) -> None:
        self.calls = 0

    async def send_user_message_async(self, user_input, on_token=None, timeout_margin=30.0):
        self.calls += 1
        if self.calls == 1:
            return json.dumps([{
                "rationale": "probe: create the file to see if tools execute",
                "tool": "write_file",
                "args": {"path": "agent_medium_probe.txt", "content": "written-by-tool"},
            }])
        return json.dumps({"tool": "respond", "args": {"message": "done"}})

    def feed_result(self, result) -> None:
        self.conversation_history.append({"role": "user", "content": json.dumps(result)})


async def main() -> dict:
    from core.execution import AelvoKernel
    from core.filesystem import AelvoFileSystem
    from core.governance import MemoryEngine
    from core.orchestration import Orchestrator

    kernel = AelvoKernel(db_path=str(db_path), anchor_path=str(anchor), backup_dir=str(WS / "backups"))
    fs = AelvoFileSystem(base_path=str(WS), kernel=kernel)
    memory = MemoryEngine(db_path=str(db_path), anchor_path=str(anchor), tool_registry={}, project_name="tmp_ws")

    sys.path.insert(0, str(ROOT))
    import main as app

    tools = app.build_tool_registry(fs, kernel, memory)
    memory.tools = tools

    orchestrator = Orchestrator(memory_engine=memory, kernel=kernel, base_path=str(WS))
    agent = ScriptedAgent()
    result = await orchestrator.execute_turn(agent, "create agent_medium_probe.txt", mode="medium")
    return {
        "llm_calls": agent.calls,
        "result_status": result.get("status"),
        "node_states": {nid: str(getattr(n, "state", "?")) for nid, n in orchestrator.runtime_graph.nodes.items()},
        "file_exists": TARGET.exists(),
        "file_content": TARGET.read_text(encoding="utf-8") if TARGET.exists() else None,
        "graph_edges": list(orchestrator.runtime_graph.edges),
    }


if __name__ == "__main__":
    try:
        print(json.dumps(asyncio.run(main()), indent=2, default=str))
    except Exception as exc:  # noqa: BLE001 - probe reports failure instead of hiding it
        import traceback
        traceback.print_exc()
        print(json.dumps({"probe_error": f"{type(exc).__name__}: {exc}"}))
