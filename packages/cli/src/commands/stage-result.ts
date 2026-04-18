export interface StageRunResult {
  success: boolean;
  exitCode: number;
  error?: string;
  verdict?: 'accept' | 'reject' | 'fail';
}
