import { Record as AirtableRecord, Table as AirtableTable } from "@airtable/blocks/models";
import { Preset } from "./preset";
import { Dispatch, SetStateAction } from "react";
import { Prompt, getChatCompletion } from "./getChatCompletion";
import pRetry from 'p-retry'

export const evaluateApplicants = async (applicants: AirtableRecord[], preset: Preset, setProgress: Dispatch<SetStateAction<number>>): Promise<Record<string, unknown>[]> => {
    return Promise.all(applicants.map(async (applicant) => {
        const result: Record<string, unknown> = await evaluateApplicant(convertToPlainRecord(applicant, preset), preset)
        result[preset.evaluationApplicantField] = [{ id: applicant.id }];
        result[preset.evaluationEvaluatorField] = [{ id: preset.evaluatorRecordId }];
        setProgress(progress => progress + (1 / applicants.length))
        return result
    }))
}

const convertToPlainRecord = (applicant: AirtableRecord, preset: Preset): Record<string, string> => {
    const record = {}

    preset.applicantFields.forEach(field => {
        const questionName = field.questionName ?? ((applicant as any).parentTable as AirtableTable).getFieldById(field.fieldId).name;
        record[questionName] = applicant.getCellValueAsString(field.fieldId)
    })

    return record;
}

// TODO: test if plain JSON is better
const stringifyApplicantForLLM = (applicant: Record<string, string>): string => {
    return Object.entries(applicant)
      .filter(([, value]) => value)
      .map(([key, value]) => `### ${key}\n\n${value}`)
      .join('\n\n');
}

const evaluateApplicant = async (applicant: Record<string, string>, preset: Preset): Promise<Record<string, number | string>> => {
    let logs = "";
    const applicantString = stringifyApplicantForLLM(applicant)
    const itemResults = await Promise.all(preset.evaluationFields.map(async ({ fieldId, criteria }) => {
        // Retry-wrapper around processApplicationPrediction
        // Common failure reasons:
        // - the model doesn't follow instructions to output the ranking in the requested format
        // - the model waffles on too long and hits the token limit
        // - we hit rate limits, or just transient faults
        // Retrying (with exponential backoff) appears to fix these problems
        const { ranking, transcript } = await pRetry(
            async () => evaluateItem(applicantString, criteria),
            { onFailedAttempt: (error) => console.error(`Failed processing record on attempt ${error.attemptNumber} for criteria ${fieldId}: `, error) },
        )
        logs += `# ${fieldId}\n\n` + transcript;
        return [fieldId, ranking] as const
    }));
    
    const combined: Record<string, number | string> = Object.fromEntries(itemResults);
    if (preset.evaluationLogsField) {
        combined[preset.evaluationLogsField] = logs;
    }
    return combined;
}

// TODO: test if returning response in JSON is better
const extractFinalRanking = (text: string, rankingKeyword = 'FINAL_RANKING'): number => {
    const regex = new RegExp(`${rankingKeyword}\\s*=\\s*(\\d+)`);
    const match = text.match(regex);
  
    if (match && match[1]) {
      return parseInt(match[1]);
    }
  
    throw new Error(`Missing final ranking (${rankingKeyword})`);
};

const evaluateItem = async (applicantString: string, criteriaString: string): Promise<{ transcript: string, ranking: number }> => {
    const prompt: Prompt = [
        { role: 'user', content: applicantString },
        { role: 'system', content: `Evaluate the application above, based on the following rubric: ${criteriaString}

You should interpolate between values if any are missing on the scale. You should ignore general statements or facts about the world, and focus on what the applicant themselves has achieved. You do not need to structure your assessment similar to the answers the user has given.

Before stating your rating, first explain your reasoning thinking step by step. Then afterwards output your final answer by stating 'FINAL_RANKING = ' and then the relevant integer between the minimum and maximum values int he rubric.` },
    ];
    const completion = await getChatCompletion(prompt);
    const transcript = [...prompt, { role: 'assistant', content: completion }]
        .map((message) => `## ${message.role}\n\n${message.content}`)
        .join('\n\n');
    const ranking = extractFinalRanking(completion);
    return { transcript, ranking };
}
