"""Manifest guards and observed version/provenance; no Docker or ledger writes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("capture_manifest", Path(__file__).with_name("capture_manifest.py"))
CAPTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE)


class CaptureManifestTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "manifest.json"
        self.definition = self.root / "definition.json"
        self.model = self.root / "smoke.json"
        self.definition.write_text(json.dumps({"version": "observed-3.7", "sequence": 9}))
        self.digest = "a" * 64
        self.model.write_text(json.dumps({"summary": {"failed": 0, "total": 32},
            "expectedAdapterHash": self.digest,
            "modelProvenance": {"modelId": "observed-model", "adapterHash": self.digest}}))
        self.argv = ["capture_manifest.py", "--out", str(self.output),
            "--chaincode-definition", str(self.definition), "--model-evidence", str(self.model)]

    def call(self):
        with patch("sys.argv", self.argv):
            return CAPTURE.main()

    def test_earlier_evidence_is_retained(self):
        self.output.write_text("prior evidence")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.call()
        self.assertEqual(self.output.read_text(), "prior evidence")

    def test_missing_definition_is_not_invented(self):
        self.definition.write_text("{}")
        with self.assertRaisesRegex(ValueError, "observed version"):
            self.call()
        self.assertFalse(self.output.exists())

    def test_failed_smoke_is_not_ready(self):
        report = json.loads(self.model.read_text())
        report["summary"]["failed"] = 1
        self.model.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError, "passing smoke"):
            self.call()

    def test_other_served_adapter_is_refused(self):
        report = json.loads(self.model.read_text())
        report["modelProvenance"]["adapterHash"] = "b" * 64
        self.model.write_text(json.dumps(report))
        with self.assertRaisesRegex(ValueError, "adapter actually served"):
            self.call()

    def test_untuned_acceptance_cannot_be_called_v7_testbed_evidence(self):
        self.model.write_text(json.dumps({"summary": {"fail": 0},
            "modelProvenance": {"modelId": "untuned", "adapterHash": None}}))
        with self.assertRaisesRegex(ValueError, "adapter actually served"):
            self.call()

    def test_observed_version_and_provenance_survive_collection(self):
        for folder in ["channel-artifacts", "chaincode-staging", "build"]:
            (self.root / folder).mkdir()
        (self.root / "channel-artifacts/diasrecords_observed-3.7.sha256").write_text("c" * 64)
        (self.root / "chaincode-staging/SOURCE_SHA256").write_text("d" * 64)
        (self.root / "build/BACKEND_SOURCE_SHA256").write_text("e" * 64)
        # Host/VM calls are mocked in this unit test; it is not a live manifest.
        with patch.object(CAPTURE, "TB", str(self.root)), patch.object(CAPTURE, "run", return_value="4"), \
             patch.object(CAPTURE, "vm", return_value={"unit_test_fixture": True}):
            self.assertEqual(self.call(), 0)
        manifest = json.loads(self.output.read_text())
        self.assertEqual(manifest["fabric"]["chaincode"]["version"], "observed-3.7")
        self.assertEqual(manifest["fabric"]["chaincode"]["sequence"], 9)
        self.assertEqual(manifest["model"]["observed_recommendation_provenance"]["modelId"], "observed-model")


if __name__ == "__main__":
    unittest.main()
