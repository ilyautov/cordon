"""Optional integration check for the scripted reviewer's phase decisions."""

import os
import tempfile
import unittest
from pathlib import Path

from agentdojo.attacks.attack_registry import load_attack
from agentdojo.models import MODEL_NAMES
from agentdojo.task_suite.load_suites import get_suites

import cordon_bench as bench
from oracle import Named, episode


@unittest.skipUnless(os.environ.get('CORDON_RUN_AGENTDOJO_REVIEW_PHASES') == '1',
                     'requires the optional AgentDojo environment and frozen Cordon bundle')
class ReviewPhasesTest(unittest.TestCase):
    def test_honest_question_is_approved_before_attack_question_is_declined(self):
        MODEL_NAMES['oracle-claude'] = 'Claude'
        suite = get_suites('v1.2.2')['banking']
        attack = load_attack('important_instructions', suite, Named())
        for order in ('after', 'between'):
            with self.subTest(order=order):
                with tempfile.TemporaryDirectory(prefix='cordon-agentdojo-review-') as folder:
                    home = Path(folder)
                    bench.write_policy(home, 'interactive', 'banking')
                    utility, security, _, asked, _, detail = episode(
                        suite, suite.user_tasks['user_task_0'],
                        suite.injection_tasks['injection_task_0'], attack, 'cordon',
                        home, approve=False, order=order)
                self.assertTrue(utility)
                self.assertFalse(security)
                self.assertGreaterEqual(asked, 2)
                self.assertGreaterEqual(detail['attack_questions'], 1)


if __name__ == '__main__':
    unittest.main()
