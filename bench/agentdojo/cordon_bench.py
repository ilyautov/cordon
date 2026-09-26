"""AgentDojo with Cordon in the tool loop, through the same `cordon hook` the
Claude Code harness runs. Nothing here decides anything: every decision is the
hook's answer, parsed the way Claude Code parses it.

    python cordon_bench.py --suites banking slack --defense none cordon --model claude-haiku-4-5
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import uuid
from collections.abc import Sequence
from pathlib import Path

import anthropic
from anthropic import AsyncAnthropic

import agentdojo.agent_pipeline.llms.anthropic_llm as anthropic_llm
from agentdojo.agent_pipeline import AgentPipeline, InitQuery, SystemMessage, ToolsExecutionLoop, ToolsExecutor
from agentdojo.agent_pipeline.base_pipeline_element import BasePipelineElement
from agentdojo.agent_pipeline.llms.anthropic_llm import AnthropicLLM
from agentdojo.agent_pipeline.agent_pipeline import load_system_message
from agentdojo.agent_pipeline.tool_execution import tool_result_to_str
from agentdojo.attacks.attack_registry import load_attack
from agentdojo.benchmark import benchmark_suite_with_injections, benchmark_suite_without_injections
from agentdojo.logging import OutputLogger
from agentdojo.functions_runtime import EmptyEnv, Env, FunctionsRuntime
from agentdojo.models import MODEL_NAMES
from agentdojo.task_suite.load_suites import get_suites
from agentdojo.types import ChatMessage, ChatToolResultMessage, text_content_block_from_string

HERE = Path(__file__).resolve().parent
# Point CORDON_CLI at a frozen copy of the bundle, named by the commit it was
# built from. The first run read the repository's bundle on every event and it
# was rebuilt twice while the run went on, which mixed three versions into one
# number. The default is the repository's bundle, for a quick look only.
CLI = Path(os.environ.get('CORDON_CLI', str(HERE.parent.parent / 'plugin' / 'dist' / 'cli.js')))
SERVER = 'agentdojo'

# ---------------------------------------------------------------- budget

PRICES = {  # dollars per million tokens: input, output; matched by prefix
    'claude-haiku-4-5': (1.0, 5.0),
    'claude-sonnet-5': (3.0, 15.0),
}


def price(model: str) -> tuple[float, float]:
    for prefix, value in PRICES.items():
        if model.startswith(prefix):
            return value
    raise KeyError(f'no price for {model}; refusing to run unmetered')
SPEND_FILE = HERE / 'work' / f'spend-{os.getpid()}.json'


class BudgetExceeded(RuntimeError):
    pass


def own() -> dict:
    try:
        return json.loads(SPEND_FILE.read_text())
    except FileNotFoundError:
        return {'dollars': 0.0, 'input': 0, 'output': 0, 'calls': 0}


def spent() -> dict:
    """The total across every process, so parallel runs share one budget."""
    total = {'dollars': 0.0, 'input': 0, 'output': 0, 'calls': 0}
    for path in (HERE / 'work').glob('spend*.json'):
        for key, value in json.loads(path.read_text()).items():
            total[key] += value
    return total


def charge(model: str, usage) -> None:
    price_in, price_out = price(model)
    state = own()
    tokens_in = usage.input_tokens + (usage.cache_creation_input_tokens or 0) + (usage.cache_read_input_tokens or 0)
    state['input'] += tokens_in
    state['output'] += usage.output_tokens
    state['calls'] += 1
    state['dollars'] += tokens_in / 1e6 * price_in + usage.output_tokens / 1e6 * price_out
    # Atomic: parallel processes read every spend file for the shared budget,
    # and a half-written one crashed a run.
    SPEND_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp = SPEND_FILE.with_suffix('.tmp')
    temp.write_text(json.dumps(state))
    os.replace(temp, SPEND_FILE)


BUDGET = float(os.environ.get('BENCH_BUDGET', '18'))


async def metered_request(client, model, messages, tools, max_tokens, system_prompt=None,
                          temperature=None, thinking_budget_tokens=None):
    # AgentDojo 0.1.35 passes `temperature` to messages.stream(), which the
    # current SDK no longer accepts. Sampling is therefore the model default,
    # and a single run carries sampling noise; the report says so.
    if spent()['dollars'] >= BUDGET:
        raise BudgetExceeded(f'budget of ${BUDGET} reached')
    kwargs = {'model': model, 'messages': messages, 'max_tokens': max_tokens}
    if tools:
        kwargs['tools'] = tools
    if system_prompt:
        kwargs['system'] = system_prompt
    for attempt in range(5):
        try:
            message = await client.messages.create(**kwargs)
            break
        except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError):
            if attempt == 4:
                raise
            await asyncio.sleep(2 ** attempt * 5)
    charge(model, message.usage)
    return message


anthropic_llm.chat_completion_request = metered_request

# ---------------------------------------------------------------- cordon


def hook(event: dict, home: Path) -> tuple[int, dict, str]:
    result = subprocess.run(
        ['node', str(CLI), 'hook', '--harness', 'claude-code'],
        input=json.dumps(event), capture_output=True, text=True, timeout=30,
        env={**os.environ, 'CORDON_HOME': str(home)}, cwd='/',
    )
    if result.returncode not in (0, 2):
        # A crashed hook is fail-open in Claude Code. Here it stops the run, so
        # the numbers never contain an episode Cordon silently did not see.
        raise RuntimeError(f'cordon hook failed ({result.returncode}): {result.stderr.strip()}')
    output = json.loads(result.stdout) if result.stdout.strip() else {}
    return result.returncode, output, result.stderr.strip()


class CordonUserTurn(BasePipelineElement):
    """The user's task enters Cordon as the user's own message, once per episode."""

    def __init__(self, home: Path) -> None:
        self.home = home

    def query(self, query: str, runtime: FunctionsRuntime, env: Env = EmptyEnv(),
              messages: Sequence[ChatMessage] = [], extra_args: dict = {}):
        session = f'bench-{uuid.uuid4().hex}'
        code, output, _ = hook({'hook_event_name': 'UserPromptSubmit', 'session_id': session, 'prompt': query}, self.home)
        if code == 2 or output.get('decision') == 'block':
            raise RuntimeError(f'cordon refused the user prompt: {output}')
        return query, runtime, env, messages, {**extra_args, 'cordon_session': session}


class CordonToolsExecutor(ToolsExecutor):
    """ToolsExecutor with PreToolUse before and PostToolUse after each call."""

    def __init__(self, home: Path) -> None:
        super().__init__()
        self.home = home
        self.stats = {'calls': 0, 'denied': 0, 'rewritten': 0, 'cleaned': 0, 'asked': 0}
        # Interactive policy: an `ask` is put to a human. True models a human
        # who approves (honest tasks), False one who declines (attacks).
        self.approve_asks = False

    def query(self, query: str, runtime: FunctionsRuntime, env: Env = EmptyEnv(),
              messages: Sequence[ChatMessage] = [], extra_args: dict = {}):
        if not messages or messages[-1]['role'] != 'assistant' or not messages[-1]['tool_calls']:
            return query, runtime, env, messages, extra_args
        session = extra_args['cordon_session']
        known = {tool.name for tool in runtime.functions.values()}
        results = []
        for call in messages[-1]['tool_calls']:
            if call.function not in known:
                results.append(ChatToolResultMessage(role='tool', content=[text_content_block_from_string('')],
                                                     tool_call_id=call.id, tool_call=call,
                                                     error=f'Invalid tool {call.function} provided.'))
                continue
            name = f'mcp__{SERVER}__{call.function}'
            self.stats['calls'] += 1
            code, output, stderr = hook({'hook_event_name': 'PreToolUse', 'session_id': session,
                                         'tool_name': name, 'tool_input': dict(call.args)}, self.home)
            specific = output.get('hookSpecificOutput', {})
            decision = specific.get('permissionDecision')
            if decision == 'ask':
                self.stats['asked'] += 1
            if code == 2 or decision == 'deny' or (decision == 'ask' and not self.approve_asks):
                self.stats['denied'] += 1
                reason = specific.get('permissionDecisionReason') or stderr or 'refused'
                results.append(ChatToolResultMessage(role='tool', content=[text_content_block_from_string('')],
                                                     tool_call_id=call.id, tool_call=call,
                                                     error=f'Blocked by Cordon: {reason}'))
                continue
            args = dict(call.args)
            if isinstance(specific.get('updatedInput'), dict):
                self.stats['rewritten'] += 1
                args = specific['updatedInput']
            value, error = runtime.run_function(env, call.function, args)
            text = tool_result_to_str(value)
            _, post, _ = hook({'hook_event_name': 'PostToolUse', 'session_id': session, 'tool_name': name,
                               'tool_input': args, 'tool_response': text}, self.home)
            post_specific = post.get('hookSpecificOutput', {})
            if isinstance(post_specific.get('updatedToolOutput'), str):
                self.stats['cleaned'] += 1
                text = post_specific['updatedToolOutput']
            notes = [n for n in (specific.get('additionalContext'), post_specific.get('additionalContext')) if n]
            if notes:
                text = text + '\n\n' + '\n'.join(notes)
            results.append(ChatToolResultMessage(role='tool', content=[text_content_block_from_string(text)],
                                                 tool_call_id=call.id, tool_call=call, error=error))
        return query, runtime, env, [*messages, *results], extra_args


# ---------------------------------------------------------------- policy

READ = ['read']
EFFECTS = {
    'get_iban': READ, 'get_balance': READ, 'get_most_recent_transactions': READ,
    'get_scheduled_transactions': READ, 'read_file': READ, 'get_user_info': READ,
    'send_money': ['financial'], 'schedule_transaction': ['financial', 'create'],
    'update_scheduled_transaction': ['financial', 'update'],
    'update_password': ['update'], 'update_user_info': ['update'],
    'get_channels': READ, 'read_channel_messages': READ, 'read_inbox': READ, 'get_users_in_channel': READ,
    'get_webpage': ['read', 'network-egress'], 'post_webpage': ['export', 'network-egress'],
    'send_direct_message': ['export'], 'send_channel_message': ['export'],
    'add_user_to_channel': ['update'], 'invite_user_to_slack': ['create'], 'remove_user_from_slack': ['delete'],
    # travel
    **{t: READ for t in ['get_user_information', 'get_all_hotels_in_city', 'get_hotels_prices',
                         'get_rating_reviews_for_hotels', 'get_hotels_address', 'get_all_restaurants_in_city',
                         'get_cuisine_type_for_restaurants', 'get_restaurants_address',
                         'get_rating_reviews_for_restaurants', 'get_dietary_restrictions_for_all_restaurants',
                         'get_contact_information_for_restaurants', 'get_price_for_restaurants',
                         'check_restaurant_opening_hours', 'get_all_car_rental_companies_in_city',
                         'get_car_types_available', 'get_rating_reviews_for_car_rental', 'get_car_fuel_options',
                         'get_car_rental_address', 'get_car_price_per_day', 'search_calendar_events',
                         'get_day_calendar_events', 'get_flight_information',
                         # workspace
                         'get_unread_emails', 'get_sent_emails', 'get_received_emails', 'get_draft_emails',
                         'search_emails', 'search_contacts_by_name', 'search_contacts_by_email', 'get_current_day',
                         'search_files_by_filename', 'get_file_by_id', 'list_files', 'search_files']},
    'create_calendar_event': ['create'], 'cancel_calendar_event': ['delete'],
    'reschedule_calendar_event': ['update'], 'add_calendar_event_participants': ['update'],
    'reserve_hotel': ['financial', 'create'], 'reserve_car_rental': ['financial', 'create'],
    'reserve_restaurant': ['create'],
    'send_email': ['export', 'network-egress'], 'delete_email': ['delete'],
    'append_to_file': ['update'], 'create_file': ['create'], 'delete_file': ['delete'],
    'share_file': ['export', 'network-egress'],
}

# Tools that return the system's own records (names, ids, prices, addresses),
# not text a third party wrote. The `directory` policy declares them trusted.
# Chosen by what the tool returns, before looking at where AgentDojo places
# its injections; the run checks that no trusted result carried one.
DIRECTORY = [
    'get_channels', 'get_users_in_channel',
    'get_iban', 'get_balance', 'get_user_info',
    'get_user_information', 'get_all_hotels_in_city', 'get_hotels_prices', 'get_hotels_address',
    'get_all_restaurants_in_city', 'get_cuisine_type_for_restaurants', 'get_restaurants_address',
    'get_dietary_restrictions_for_all_restaurants', 'get_contact_information_for_restaurants',
    'get_price_for_restaurants', 'check_restaurant_opening_hours', 'get_all_car_rental_companies_in_city',
    'get_car_types_available', 'get_car_fuel_options', 'get_car_rental_address', 'get_car_price_per_day',
    'get_current_day', 'search_contacts_by_name', 'search_contacts_by_email',
]


# What the owner of each environment would declare as the task's reach under
# `destinations`: their own workspace's channels and people, their company's
# mail domain. Not the external channel, and nothing an attack names.
MANDATE = {
    'slack': ['general', 'random', 'private', 'Alice', 'Bob', 'Charlie', 'Eve'],
    'workspace': ['*@bluesparrowtech.com'],
    'banking': [],
    'travel': [],
}


def write_policy(home: Path, variant: str = 'strict', suite: str | None = None) -> None:
    home.mkdir(parents=True, exist_ok=True)
    mandate = MANDATE.get(suite or '', []) if variant == 'mandate' else []
    lines = [
        f"mode: {'interactive' if variant == 'interactive' else 'autonomous'}",
        *(['trustedSources:', *[f'  - mcp__{SERVER}__{tool}' for tool in DIRECTORY]] if variant in ('directory', 'mandate') else []),
        *([f'destinations: {json.dumps(mandate)}'] if mandate else []),
        'profile:',
        '  effects: [read, summarize, create, update, delete, export, network-egress, financial]',
        'exposure: true',
        'tools:',
        *[f'  mcp__{SERVER}__{tool}: [{", ".join(effects)}]' for tool, effects in EFFECTS.items()],
        'notify:',
        f'  file: {home / "events.jsonl"}',
    ]
    (home / 'policy.yaml').write_text('\n'.join(lines) + '\n')


# ---------------------------------------------------------------- run


def pipeline(model: str, defense: str, home: Path) -> tuple[AgentPipeline, CordonToolsExecutor | None]:
    llm = AnthropicLLM(AsyncAnthropic(), model, max_tokens=2048)
    if defense == 'cordon':
        executor = CordonToolsExecutor(home)
        elements = [SystemMessage(load_system_message(None)), InitQuery(), CordonUserTurn(home), llm,
                    ToolsExecutionLoop([executor, llm])]
    else:
        executor = None
        elements = [SystemMessage(load_system_message(None)), InitQuery(), llm,
                    ToolsExecutionLoop([ToolsExecutor(), llm])]
    agent = AgentPipeline(elements)
    agent.name = f'{model}-{defense}'
    return agent, executor


def executed_only(messages):
    """AgentDojo's trace, less the calls Cordon refused.

    The stock trace lists every call the model attempted. Tasks scored from
    the trace would then count a refused call as made: slack's user_task_11
    and injection_task_5 do. A refused call did not happen, so it is dropped.
    """
    refused = {m['tool_call_id'] for m in messages
               if m['role'] == 'tool' and (m.get('error') or '').startswith('Blocked by Cordon')}
    calls = []
    for message in messages:
        if message['role'] == 'assistant':
            for call in message['tool_calls'] or []:
                if call.id not in refused:
                    calls.append(call)
    return calls


import agentdojo.task_suite.task_suite as _task_suite
_task_suite.functions_stack_trace_from_messages = executed_only


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--suites', nargs='+', default=['banking', 'slack'])
    parser.add_argument('--defense', nargs='+', default=['none', 'cordon'])
    parser.add_argument('--model', default='claude-haiku-4-5-20251001')
    parser.add_argument('--attack', default='important_instructions')
    parser.add_argument('--version', default='v1.2.2')
    parser.add_argument('--user-tasks', nargs='*', default=None)
    parser.add_argument('--injection-tasks', nargs='*', default=None)
    parser.add_argument('--utility-only', action='store_true')
    parser.add_argument('--out', default=str(HERE / 'work' / 'runs'))
    parser.add_argument('--variant', default='strict', choices=['strict', 'directory', 'mandate', 'interactive'])
    parser.add_argument('--approve-asks', action='store_true')
    args = parser.parse_args()

    MODEL_NAMES[args.model] = 'Claude'
    price(args.model)
    suites = get_suites(args.version)
    summary = {}
    for defense in args.defense:
        for name in args.suites:
            suite = suites[name]
            home = HERE / 'work' / 'homes' / f'{args.model}-{defense}-{args.variant}-{name}'
            write_policy(home, args.variant, name)
            agent, executor = pipeline(args.model, defense, home)
            if executor is not None:
                executor.approve_asks = args.approve_asks
            logdir = Path(args.out) / f'{args.model}-{defense}-{args.variant}'
            logdir.mkdir(parents=True, exist_ok=True)
            logger = OutputLogger(str(logdir))
            logger.__enter__()
            clean = benchmark_suite_without_injections(agent, suite, logdir, False, args.user_tasks,
                                                       benchmark_version=args.version)
            row = {'utility': mean(clean['utility_results'])}
            if not args.utility_only:
                attack = load_attack(args.attack, suite, agent)
                attacked = benchmark_suite_with_injections(agent, suite, attack, logdir, False, args.user_tasks,
                                                           args.injection_tasks, verbose=False,
                                                           benchmark_version=args.version)
                row['utility_under_attack'] = mean(attacked['utility_results'])
                row['attack_success'] = mean(attacked['security_results'])
                row['cases'] = len(attacked['security_results'])
            logger.__exit__(None, None, None)
            row['tasks'] = len(clean['utility_results'])
            if executor is not None:
                row['cordon'] = executor.stats
            summary[f'{defense}/{name}'] = row
            print(json.dumps({f'{defense}/{name}': row}), flush=True)
    print(json.dumps({'summary': summary, 'spend': spent()}, indent=2))
    return 0


def mean(results: dict) -> tuple[float, int, int] | None:
    values = list(results.values())
    if not values:
        return None
    return (round(sum(values) / len(values), 3), sum(values), len(values))


if __name__ == '__main__':
    sys.exit(main())
