'use strict';

const svc = require('../services/bullMQRetryService');
const { asyncHandler } = require('../middleware/errorHandler');
const { logAudit } = require('../services/auditService');

const getStats = asyncHandler(async (req, res) => {
  const data = await svc.getRetryQueueStats();
  res.json({ success: true, data });
});

const getHealth = asyncHandler(async (req, res) => {
  const h = await svc.getHealthStatus();
  res.status(h.healthy ? 200 : 503).json({ success: true, data: h });
});

const getJob = asyncHandler(async (req, res) => {
  const data = await svc.getJobDetails(req.params.jobId);
  res.json({ success: true, data });
});

const getJobs = asyncHandler(async (req, res) => {
  const jobs = await svc.getJobsByState(req.params.state, parseInt(req.query.limit) || 50);
  res.json({ success: true, data: { state: req.params.state, count: jobs.length, jobs } });
});

const manualRetry = asyncHandler(async (req, res) => {
  const data = await svc.retryJobImmediately(req.params.jobId);
  await logAudit({
    schoolId: req.schoolId || 'system',
    action: 'RETRY_QUEUE_JOB_RETRIED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetId: req.params.jobId,
    targetType: 'retryJob',
    details: data,
  });
  res.json({ success: true, data });
});

const deleteJob = asyncHandler(async (req, res) => {
  const data = await svc.removeJob(req.params.jobId);
  await logAudit({
    schoolId: req.schoolId || 'system',
    action: 'RETRY_QUEUE_JOB_DELETED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetId: req.params.jobId,
    targetType: 'retryJob',
    details: data,
  });
  res.json({ success: true, data });
});

const pause = asyncHandler(async (req, res) => {
  const data = await svc.pauseQueue();
  await logAudit({
    schoolId: req.schoolId || 'system',
    action: 'RETRY_QUEUE_PAUSED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetType: 'retryQueue',
    details: data,
  });
  res.json({ success: true, data });
});

const resume = asyncHandler(async (req, res) => {
  const data = await svc.resumeQueue();
  await logAudit({
    schoolId: req.schoolId || 'system',
    action: 'RETRY_QUEUE_RESUMED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetType: 'retryQueue',
    details: data,
  });
  res.json({ success: true, data });
});

const queueTransaction = asyncHandler(async (req, res) => {
  const { transactionHash, studentId, memo, error, metadata } = req.body;
  if (!transactionHash) {
    const err = new Error('transactionHash is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  const data = await svc.queueFailedTransaction(transactionHash, {
    studentId, memo, error: error ? new Error(error.message) : null, metadata,
  });
  await logAudit({
    schoolId: req.schoolId || 'system',
    action: 'RETRY_QUEUE_TRANSACTION_QUEUED',
    performedBy: req.auditContext?.performedBy,
    ipAddress: req.auditContext?.ipAddress,
    userAgent: req.auditContext?.userAgent,
    targetId: transactionHash,
    targetType: 'transaction',
    details: { studentId, memo, metadata },
  });
  res.json({ success: true, data });
});

module.exports = { getStats, getHealth, getJob, getJobs, manualRetry, deleteJob, pause, resume, queueTransaction };
