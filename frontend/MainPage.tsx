import {
  Button,
  FieldPicker,
  FieldPickerSynced,
  FormField,
  Input,
  InputSynced,
  ProgressBar,
  TablePickerSynced,
  Text,
  useBase,
  ViewPickerSynced,
} from "@airtable/blocks/ui";
import React, { useState } from "react";
import { Preset, upsertPreset, useSelectedPreset } from "../lib/preset";
import { globalConfig } from "@airtable/blocks";
import { Field, FieldType } from "@airtable/blocks/models";
import { evaluateApplicants } from "../lib/evaluateApplicants";

const renderPreviewText = (numberOfApplicants: number, numberOfEvaluationCriteria: number) => {
  const numberOfItems = numberOfApplicants * numberOfEvaluationCriteria;
  const timeEstimate = (numberOfItems * 18 / 60).toFixed(1); // speed roughly for gpt-4-1106-preview
  const costEstimate = (numberOfItems * 0.011).toFixed(2); // pricing roughly for gpt-4-1106-preview
  return `Found ${numberOfApplicants} records, and ${numberOfEvaluationCriteria} evaluation criteria for a total of ${numberOfItems} items to process. Estimated time: ${timeEstimate} min. Estimated cost: £${costEstimate}. To cancel, please close the entire browser tab.`
}

export const MainPage = () => {
  const preset = useSelectedPreset();

  const base = useBase();
  const applicantTable = base.getTableByIdIfExists(preset.applicantTableId);
  const evaluationTable = base.getTableByIdIfExists(preset.evaluationTableId)

  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0) // between 0.0 and 1.0
  const [result, setResult] = useState<string>(null)
  const run = async () => {
    setRunning(true);
    setProgress(0);
    setResult(null);
    try {
      if (!applicantTable) throw new Error('Could not access applicant table')
      if (!evaluationTable) throw new Error('Could not access evaluation table')
      if (!preset.applicantFields.length) throw new Error('No input fields selected')
      if (!preset.evaluationFields.length) throw new Error('No output fields selected')
      setResult('Getting applicant records...')
      const applicantView = applicantTable.getViewById(preset.applicantViewId);
      const applicantRecords = await applicantView.selectRecordsAsync()
      setResult(renderPreviewText(applicantRecords.records.length, preset.evaluationFields.length))
      const evaluationRecords = await evaluateApplicants(applicantRecords.records, preset, setProgress)
      setResult(`Evaluated applicants, creating evaluations in table...`)
      await evaluationTable.createRecordsAsync(evaluationRecords.map(record => ({ fields: record })));
      setResult(`Successfully created ${evaluationRecords.length} evaluation(s)`)
    } catch (error) {
      const errorMessage = 'Error: ' + (error instanceof Error ? error.message : String(error))
      setResult(errorMessage);
      setRunning(false);
    }
    setRunning(false);
  };

  return (
    <div className="mb-24">
      <FormField label="Applicant table">
        <TablePickerSynced
          globalConfigKey={["presets", preset.name, "applicantTableId"]}
          onChange={() => {
            globalConfig.setAsync(["presets", preset.name, "applicantViewId"], '');
            globalConfig.setAsync(["presets", preset.name, "applicantFields"], []);
          }}
        />
      </FormField>
      {applicantTable && (<>
        <FormField label="Applicant view">
          <ViewPickerSynced
            globalConfigKey={["presets", preset.name, "applicantViewId"]}
            table={applicantTable}
          />
        </FormField>
        <FormField label="Answer (input) fields">
          <div className="flex flex-col gap-2">
            {preset.applicantFields.map((_, index) => <ApplicantFieldEditor key={index} preset={preset} index={index} />)}
            <ApplicantFieldEditor key={preset.applicantFields.length} preset={preset} index={preset.applicantFields.length} />
          </div>
        </FormField>
      </>)}

      <FormField label="Evaluation table">
        <TablePickerSynced
          globalConfigKey={["presets", preset.name, "evaluationTableId"]}
          onChange={() => {
            globalConfig.setAsync(["presets", preset.name, "evaluationFields"], []);
            globalConfig.setAsync(["presets", preset.name, "evaluationLogsField"], undefined);
          }}
        />
      </FormField>
      {evaluationTable && (<>
        <FormField label="Score (output) fields">
          <div className="flex flex-col gap-2">
            {preset.evaluationFields.map((_, index) => <EvaluationFieldEditor key={index} preset={preset} index={index} />)}
            <EvaluationFieldEditor key={preset.evaluationFields.length} preset={preset} index={preset.evaluationFields.length} />
          </div>
        </FormField>
        <FormField label="Applicant field">
          <FieldPickerSynced
            allowedTypes={[FieldType.MULTIPLE_RECORD_LINKS]}
            globalConfigKey={["presets", preset.name, "evaluationApplicantField"]}
            table={evaluationTable}
          />
        </FormField>
        <FormField label="Evaluator field">
          <FieldPickerSynced
            allowedTypes={[FieldType.MULTIPLE_RECORD_LINKS]}
            globalConfigKey={["presets", preset.name, "evaluationEvaluatorField"]}
            table={evaluationTable}
          />
        </FormField>
        <FormField label="Evaluator record ID">
          <InputSynced
            globalConfigKey={["presets", preset.name, "evaluatorRecordId"]}
            placeholder="rec1234"
          />
        </FormField>
        <FormField label="(optional) Logs field">
          <FieldPickerSynced
            allowedTypes={[FieldType.SINGLE_LINE_TEXT, FieldType.MULTILINE_TEXT, FieldType.RICH_TEXT]}
            globalConfigKey={["presets", preset.name, "evaluationLogsField"]}
            table={evaluationTable}
          />
        </FormField>
      </>)}

      <Button
        // @ts-ignore
        type="[workaround]"
        variant="primary"
        icon="play"
        onClick={run}
        disabled={running}
      >
          Run
      </Button>
      {running && <ProgressBar className="my-2" progress={progress} />}
      {result && <Text className="my-2">{result}</Text>}
    </div>
  );
};

interface FieldEditorProps {
  preset: Preset;
  index: number;
}

const ApplicantFieldEditor: React.FC<FieldEditorProps> = ({ preset, index }) => {
  const applicantField = preset.applicantFields[index] ?? { fieldId: '' };

  const base = useBase();
  const applicantTable = base.getTableByIdIfExists(preset.applicantTableId);

  const [field, setField] = useState<Field>(applicantTable.getFieldByIdIfExists(applicantField.fieldId));
  const [questionName, setQuestionName] = useState<string>(applicantField.questionName ?? '');

  const saveField = (applicantField: Preset['applicantFields'][number]) => {
    // delete
    if (!applicantField.fieldId) {
      upsertPreset({ ...preset, applicantFields: preset.applicantFields.filter((_, i) => i !== index) })
    // create
    } else if (index >= preset.applicantFields.length) {
      upsertPreset({ ...preset, applicantFields: [...preset.applicantFields, applicantField] })
    } else {
      upsertPreset({ ...preset, applicantFields: preset.applicantFields.map((original, i) => i === index ? applicantField : original) })
    }
  }
  
  return (
    <div className="p-2 border bg-white rounded shadow grid grid-cols-2 gap-2">
      <FormField label="Source field" className="mb-0">
        <FieldPicker
          table={applicantTable}
          shouldAllowPickingNone={true}
          onChange={(field) => { setField(field); saveField({ ...applicantField, fieldId: field?.id }) }}
          field={field}
        />
      </FormField>
      <FormField label="(optional) Question name" className="mb-0">
        <Input
          value={questionName}
          onChange={(event) => { setQuestionName(event.target.value); saveField({ ...applicantField, questionName: event.target.value || undefined }) }}
        />
      </FormField>
    </div>
  )
}

const EvaluationFieldEditor: React.FC<FieldEditorProps> = ({ preset, index }) => {
  const evaluationField = preset.evaluationFields[index] ?? { fieldId: '', criteria: '' };

  const base = useBase();
  const evaluationTable = base.getTableByIdIfExists(preset.evaluationTableId);

  const [field, setField] = useState<Field>(evaluationTable.getFieldByIdIfExists(evaluationField.fieldId));
  const [criteria, setCriteria] = useState<string>(evaluationField.criteria ?? '');

  const saveField = (evaluationField: Preset['evaluationFields'][number]) => {
    // delete
    if (!evaluationField.fieldId) {
      upsertPreset({ ...preset, evaluationFields: preset.evaluationFields.filter((_, i) => i !== index) })
    // create
    } else if (index >= preset.evaluationFields.length) {
      upsertPreset({ ...preset, evaluationFields: [...preset.evaluationFields, evaluationField] })
    } else {
      upsertPreset({ ...preset, evaluationFields: preset.evaluationFields.map((original, i) => i === index ? evaluationField : original) })
    }
  }
  
  return (
    <div className="p-2 border bg-white rounded shadow grid grid-cols-2 gap-2">
      <FormField label="Output field" className="mb-0">
        <FieldPicker
          allowedTypes={[FieldType.NUMBER, FieldType.PERCENT, FieldType.RATING]}
          table={evaluationTable}
          shouldAllowPickingNone={true}
          onChange={(field) => { setField(field); saveField({ ...evaluationField, fieldId: field?.id }) }}
          field={field}
        />
      </FormField>
      <FormField label="Evaluation criteria" className="mb-0">
        <Input
          value={criteria}
          onChange={(event) => { setCriteria(event.target.value); saveField({ ...evaluationField, criteria: event.target.value || undefined }) }}
        />
      </FormField>
    </div>
  )
}
