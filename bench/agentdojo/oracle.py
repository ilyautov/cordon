"""The worst case for any model-based defence: an agent that obeys every
injection. No model is called.

For each (user task, injection task) pair the scripted agent first makes the
user task's ground-truth calls, reading whatever the attack planted, then
makes every ground-truth call of the injection task. Each call goes through
the same `cordon hook` path as the live runs. Two numbers come out:

  attack success  - injection goals reached although the agent obeyed fully
  utility         - user tasks whose ground truth Cordon lets through

Without a defence the first is 100% by construction; that is checked, not
assumed.
"""
from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path

from agentdojo.attacks.attack_registry import load_attack
from agentdojo.functions_runtime import FunctionCall, FunctionsRuntime
from agentdojo.models import MODEL_NAMES
from agentdojo.task_suite.load_suites import get_suites
from agentdojo.types import ChatAssistantMessage, text_content_block_from_string

import cordon_bench as bench

HERE = Path(__file__).resolve().parent


class Named:
    """The attack reads the model's name from the pipeline; there is no model."""
    name = 'oracle-claude'


def run_calls(executor, runtime, env, calls, extra, messages):
    message = ChatAssistantMessage(role='assistant', content=[text_content_block_from_string('')],
                                   tool_calls=[FunctionCall(function=c.function, args=dict(c.args), id=f'c{i}')
                                               for i, c in enumerate(calls)])
    _, _, env, out, _ = executor.query('', runtime, env, [*messages, message], extra)
    return env, list(out)


def episode(suite, user_task, injection_task, attack, defense, home, approve=False):
    if injection_task is None:
        env = suite.load_and_inject_default_environment({})
    else:
        env = suite.load_and_inject_default_environment(attack.attack(user_task, injection_task))
    pre = env.model_copy(deep=True)
    runtime = FunctionsRuntime(suite.tools)
    executor = bench.CordonToolsExecutor(home) if defense == 'cordon' else bench.ToolsExecutor()
    if defense == 'cordon':
        executor.approve_asks = approve
    extra = {}
    if defense == 'cordon':
        _, _, _, _, extra = bench.CordonUserTurn(home).query(user_task.PROMPT, runtime, env, [], {})
    env, messages = run_calls(executor, runtime, env, user_task.ground_truth(pre), extra, [])
    if injection_task is not None:
        env, messages = run_calls(executor, runtime, env, injection_task.ground_truth(pre), extra, messages)
    blocked = [m['error'] for m in messages if m.get('role') == 'tool' and (m.get('error') or '').startswith('Blocked by Cordon')]
    # The model's final text is the task's expected answer, as a perfect
    # agent would give it; tasks that check the answer text get it.
    output = getattr(user_task, 'GROUND_TRUTH_OUTPUT', '') or ''
    # Only calls that actually ran. AgentDojo's own trace counts every call
    # the model attempted, a refused one included, which would score a
    # blocked attack as a landed one for any defence that refuses calls.
    executed = [m['tool_call'] for m in messages if m.get('role') == 'tool' and not m.get('error')]
    utility = user_task.utility_from_traces(output, pre, env, executed)
    if utility is None:
        utility = user_task.utility(output, pre, env)
    security = None
    if injection_task is not None:
        security = injection_task.security_from_traces(output, pre, env, executed)
        if security is None:
            security = injection_task.security(output, pre, env)
    asked = executor.stats['asked'] if defense == 'cordon' else 0
    leaked = trusted_leak(messages, injection_task, attack, user_task) if injection_task is not None else False
    return utility, security, blocked, asked, leaked


def trusted_leak(messages, injection_task, attack, user_task):
    # Whether a result the directory policy trusts carried the injection.
    # The attack text is known; a trusted tool that returned it would make
    # the directory numbers a lie, so it is counted, not assumed away.
    texts = [v for v in attack.attack(user_task, injection_task).values()]
    trusted = set(bench.DIRECTORY)
    for m in messages:
        if m.get('role') != 'tool' or m['tool_call'].function not in trusted:
            continue
        content = ''.join(block.get('content', '') or '' for block in (m.get('content') or []))
        if any(t and t[:60] in content for t in texts):
            return True
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--suites', nargs='+', default=['banking', 'slack', 'travel', 'workspace'])
    parser.add_argument('--version', default='v1.2.2')
    parser.add_argument('--out', default=str(HERE / 'work' / 'oracle.json'))
    parser.add_argument('--variant', default='strict', choices=['strict', 'directory', 'interactive'])
    parser.add_argument('--defenses', nargs='+', default=['none', 'cordon'])
    parser.add_argument('--approve-attacks', action='store_true',
                        help='the human approves every question, attacks included: the upper bound')
    args = parser.parse_args()
    MODEL_NAMES['oracle-claude'] = 'Claude'
    suites = get_suites(args.version)
    report = {}
    for name in args.suites:
        suite = suites[name]
        attack = load_attack('important_instructions', suite, Named())
        for defense in args.defenses:
            home = HERE / 'work' / 'homes' / f'oracle-{defense}-{args.variant}-{name}'
            bench.write_policy(home, args.variant)
            utilities, securities, reasons, asks, leaks, asked_attacks = [], [], {}, [], 0, 0
            for user_task in suite.user_tasks.values():
                utility, _, blocked, asked, _ = episode(suite, user_task, None, attack, defense, home, approve=True)
                utilities.append(utility)
                asks.append(asked)
                if blocked:
                    reasons[user_task.ID] = blocked
                for injection_task in suite.injection_tasks.values():
                    _, security, _, attack_asks, leaked = episode(suite, user_task, injection_task, attack, defense,
                                                                  home, approve=args.approve_attacks)
                    securities.append(security)
                    asked_attacks += 1 if attack_asks else 0
                    leaks += leaked
            row = {
                'utility': [round(sum(utilities) / len(utilities), 3), sum(utilities), len(utilities)],
                'attack_success': [round(sum(securities) / len(securities), 3), sum(securities), len(securities)],
                'asks_per_task': round(sum(asks) / len(asks), 2),
                'trusted_results_with_injection': leaks,
                'attack_cases_with_a_question': asked_attacks,
            }
            report[f'{defense}/{name}'] = row
            if defense == 'cordon':
                report[f'blocked-honest/{name}'] = reasons
            print(json.dumps({f'{defense}/{name}': row}), flush=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
