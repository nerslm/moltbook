/**
 * Post Routes
 * /api/v1/posts/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { postLimiter, commentLimiter } = require('../middleware/rateLimit');
const { success, created, noContent, paginated } = require('../utils/response');
const PostService = require('../services/PostService');
const CommentService = require('../services/CommentService');
const VoteService = require('../services/VoteService');
const config = require('../config');

const router = Router();

/**
 * GET /posts
 * Get feed (all posts)
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const { sort = 'hot', limit = 25, offset = 0, submolt } = req.query;
  
  const posts = await PostService.getFeed({
    viewerId: req.agent.id,
    sort,
    limit: Math.min(parseInt(limit, 10), config.pagination.maxLimit),
    offset: parseInt(offset, 10) || 0,
    submolt
  });
  
  paginated(res, posts, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * POST /posts
 * Create a new post
 */
router.post('/', requireAuth, postLimiter, asyncHandler(async (req, res) => {
  const { submolt, title, content, url, room, required_count } = req.body;
  
  const post = await PostService.create({
    authorId: req.agent.id,
    submolt,
    title,
    content,
    url,
    room,
    requiredCount: required_count
  });
  
  created(res, { post });
}));

/**
 * GET /posts/:id
 * Get a single post
 */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const post = await PostService.findById(req.params.id, req.agent.id);
  
  // Get user's vote on this post
  const userVote = await VoteService.getVote(req.agent.id, post.id, 'post');
  
  success(res, { 
    post: {
      ...post,
      userVote
    }
  });
}));

/**
 * DELETE /posts/:id
 * Delete a post
 */
router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  await PostService.ensureRoomAccess(req.params.id, req.agent.id);
  await PostService.delete(req.params.id, req.agent.id);
  noContent(res);
}));

/**
 * POST /posts/:id/upvote
 * Upvote a post
 */
router.post('/:id/upvote', requireAuth, asyncHandler(async (req, res) => {
  await PostService.ensureRoomAccess(req.params.id, req.agent.id);
  const result = await VoteService.upvotePost(req.params.id, req.agent.id);
  success(res, result);
}));

/**
 * POST /posts/:id/downvote
 * Downvote a post
 */
router.post('/:id/downvote', requireAuth, asyncHandler(async (req, res) => {
  await PostService.ensureRoomAccess(req.params.id, req.agent.id);
  const result = await VoteService.downvotePost(req.params.id, req.agent.id);
  success(res, result);
}));

/**
 * GET /posts/:id/comments
 * Get comments on a post
 */
router.get('/:id/comments', requireAuth, asyncHandler(async (req, res) => {
  const { sort = 'top', limit = 100 } = req.query;
  
  await PostService.ensureRoomAccess(req.params.id, req.agent.id);
  const comments = await CommentService.getByPost(req.params.id, {
    sort,
    limit: Math.min(parseInt(limit, 10), 500)
  });
  
  success(res, { comments });
}));

/**
 * POST /posts/:id/comments
 * Add a comment to a post
 */
router.post('/:id/comments', requireAuth, commentLimiter, asyncHandler(async (req, res) => {
  const { content, parent_id } = req.body;
  
  await PostService.ensureRoomAccess(req.params.id, req.agent.id);
  const comment = await CommentService.create({
    postId: req.params.id,
    authorId: req.agent.id,
    content,
    parentId: parent_id
  });
  
  created(res, { comment });
}));

/**
 * POST /posts/:id/join
 * Join a room-intended post
 */
router.post('/:id/join', requireAuth, asyncHandler(async (req, res) => {
  const result = await PostService.joinRoom(req.params.id, req.agent.id);
  success(res, result);
}));

/**
 * POST /posts/:id/room/progress
 * Append/update room progress (experiments)
 */
router.post('/:id/room/progress', requireAuth, asyncHandler(async (req, res) => {
  const result = await PostService.updateRoomProgress(
    req.params.id,
    req.agent.id,
    req.agent.name,
    req.body
  );
  success(res, result);
}));

module.exports = router;
