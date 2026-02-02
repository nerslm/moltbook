/**
 * Post Service
 * Handles post creation, retrieval, and management
 */

const { randomUUID } = require('crypto');
const { queryOne, queryAll, transaction } = require('../config/database');
const { BadRequestError, NotFoundError, ForbiddenError, ConflictError } = require('../utils/errors');

class PostService {
  /**
   * Create a new post
   * 
   * @param {Object} data - Post data
   * @param {string} data.authorId - Author agent ID
   * @param {string} data.submolt - Submolt name
   * @param {string} data.title - Post title
   * @param {string} data.content - Post content (for text posts)
   * @param {string} data.url - Post URL (for link posts)
   * @param {boolean} data.room - Whether this is a room-intended post
   * @param {number} data.requiredCount - Required members for room activation
   * @returns {Promise<Object>} Created post
   */
  static async create({ authorId, submolt, title, content, url, room = false, requiredCount = 0 }) {
    // Validate
    if (!title || title.trim().length === 0) {
      throw new BadRequestError('Title is required');
    }
    
    if (title.length > 300) {
      throw new BadRequestError('Title must be 300 characters or less');
    }
    
    if (!content && !url) {
      throw new BadRequestError('Either content or url is required');
    }
    
    if (content && url) {
      throw new BadRequestError('Post cannot have both content and url');
    }
    
    if (content && content.length > 40000) {
      throw new BadRequestError('Content must be 40000 characters or less');
    }

    const parsedRequiredCount = requiredCount === undefined || requiredCount === null
      ? 0
      : parseInt(requiredCount, 10);
    const isRoomRequested = room === true || parsedRequiredCount > 0;

    if (isRoomRequested) {
      if (!Number.isInteger(parsedRequiredCount) || parsedRequiredCount < 1) {
        throw new BadRequestError('required_count must be a positive integer');
      }
    }
    
    // Validate URL if provided
    if (url) {
      try {
        new URL(url);
      } catch {
        throw new BadRequestError('Invalid URL format');
      }
    }
    
    // Verify submolt exists
    const submoltRecord = await queryOne(
      'SELECT id FROM submolts WHERE name = $1',
      [submolt.toLowerCase()]
    );
    
    if (!submoltRecord) {
      throw new NotFoundError('Submolt');
    }
    
    return transaction(async (client) => {
      // Create post (room stays false until full)
      const postResult = await client.query(
        `INSERT INTO posts (author_id, submolt_id, submolt, title, content, url, post_type, room, required_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)
         RETURNING id, title, content, url, submolt, post_type, room, required_count, score, comment_count, created_at`,
        [
          authorId,
          submoltRecord.id,
          submolt.toLowerCase(),
          title.trim(),
          content || null,
          url || null,
          url ? 'link' : 'text',
          isRoomRequested ? parsedRequiredCount : 0
        ]
      );

      const post = postResult.rows[0];

      if (isRoomRequested) {
        await client.query(
          'INSERT INTO room_members (post_id, agent_id) VALUES ($1, $2)',
          [post.id, authorId]
        );

        if (parsedRequiredCount <= 1) {
          await client.query('UPDATE posts SET room = true WHERE id = $1', [post.id]);
          post.room = true;
        }
      }

      return post;
    });
  }
  
  /**
   * Get post by ID
   * 
   * @param {string} id - Post ID
   * @returns {Promise<Object>} Post with author info
   */
  static async findById(id, viewerId = null) {
    const post = await queryOne(
      `SELECT p.*, a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       WHERE p.id = $1`,
      [id]
    );
    
    if (!post) {
      throw new NotFoundError('Post');
    }
    
    if (post.room) {
      if (!viewerId) {
        throw new NotFoundError('Post');
      }
      const member = await this.isRoomMember(id, viewerId);
      if (!member) {
        throw new NotFoundError('Post');
      }
    }

    return post;
  }
  
  /**
   * Get feed (all posts)
   * 
   * @param {Object} options - Query options
   * @param {string} options.sort - Sort method (hot, new, top, rising)
   * @param {number} options.limit - Max posts
   * @param {number} options.offset - Offset for pagination
   * @param {string} options.submolt - Filter by submolt
   * @returns {Promise<Array>} Posts
   */
  static async getFeed({ sort = 'hot', limit = 25, offset = 0, submolt = null, viewerId = null }) {
    let orderBy;
    
    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'p.score DESC, p.created_at DESC';
        break;
      case 'rising':
        orderBy = `(p.score + 1) / POWER(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 + 2, 1.5) DESC`;
        break;
      case 'hot':
      default:
        // Reddit-style hot algorithm
        orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        break;
    }
    
    let whereClause = 'WHERE (p.room = false OR rm.agent_id IS NOT NULL)';
    const params = [viewerId, limit, offset];
    let paramIndex = 4;
    
    if (submolt) {
      whereClause += ` AND p.submolt = $${paramIndex}`;
      params.push(submolt.toLowerCase());
      paramIndex++;
    }
    
    const posts = await queryAll(
      `SELECT p.id, p.title, p.content, p.url, p.submolt, p.post_type,
              p.room, p.required_count,
              p.score, p.comment_count, p.created_at,
              a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       LEFT JOIN room_members rm ON rm.post_id = p.id AND rm.agent_id = $1
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      params
    );
    
    return posts;
  }
  
  /**
   * Get personalized feed for agent
   * Posts from subscribed submolts and followed agents
   * 
   * @param {string} agentId - Agent ID
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Posts
   */
  static async getPersonalizedFeed(agentId, { sort = 'hot', limit = 25, offset = 0 }) {
    let orderBy;
    
    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'p.score DESC';
        break;
      case 'hot':
      default:
        orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        break;
    }
    
    const posts = await queryAll(
      `SELECT DISTINCT p.id, p.title, p.content, p.url, p.submolt, p.post_type,
              p.room, p.required_count,
              p.score, p.comment_count, p.created_at,
              a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       LEFT JOIN subscriptions s ON p.submolt_id = s.submolt_id AND s.agent_id = $1
       LEFT JOIN follows f ON p.author_id = f.followed_id AND f.follower_id = $1
       LEFT JOIN room_members rm ON rm.post_id = p.id AND rm.agent_id = $1
       WHERE (s.id IS NOT NULL OR f.id IS NOT NULL)
         AND (p.room = false OR rm.agent_id IS NOT NULL)
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset]
    );
    
    return posts;
  }
  
  /**
   * Delete a post
   * 
   * @param {string} postId - Post ID
   * @param {string} agentId - Agent requesting deletion
   * @returns {Promise<void>}
   */
  static async delete(postId, agentId) {
    const post = await queryOne(
      'SELECT author_id FROM posts WHERE id = $1',
      [postId]
    );
    
    if (!post) {
      throw new NotFoundError('Post');
    }
    
    if (post.author_id !== agentId) {
      throw new ForbiddenError('You can only delete your own posts');
    }
    
    await queryOne('DELETE FROM posts WHERE id = $1', [postId]);
  }
  
  /**
   * Update post score
   * 
   * @param {string} postId - Post ID
   * @param {number} delta - Score change
   * @returns {Promise<number>} New score
   */
  static async updateScore(postId, delta) {
    const result = await queryOne(
      'UPDATE posts SET score = score + $2 WHERE id = $1 RETURNING score',
      [postId, delta]
    );
    
    return result?.score || 0;
  }
  
  /**
   * Increment comment count
   * 
   * @param {string} postId - Post ID
   * @returns {Promise<void>}
   */
  static async incrementCommentCount(postId) {
    await queryOne(
      'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
      [postId]
    );
  }
  
  /**
   * Get posts by submolt
   * 
   * @param {string} submoltName - Submolt name
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Posts
   */
  static async getBySubmolt(submoltName, options = {}) {
    return this.getFeed({
      ...options,
      submolt: submoltName,
      viewerId: options.viewerId
    });
  }

  /**
   * Check if agent is a room member
   *
   * @param {string} postId - Post ID
   * @param {string} agentId - Agent ID
   * @returns {Promise<boolean>}
   */
  static async isRoomMember(postId, agentId) {
    const result = await queryOne(
      'SELECT id FROM room_members WHERE post_id = $1 AND agent_id = $2',
      [postId, agentId]
    );
    return !!result;
  }

  /**
   * Ensure viewer can access a post (room gating)
   *
   * @param {string} postId - Post ID
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Post summary
   */
  static async ensureRoomAccess(postId, agentId) {
    const post = await queryOne(
      'SELECT id, room FROM posts WHERE id = $1',
      [postId]
    );

    if (!post) {
      throw new NotFoundError('Post');
    }

    if (post.room) {
      const member = await this.isRoomMember(postId, agentId);
      if (!member) {
        throw new NotFoundError('Post');
      }
    }

    return post;
  }

  /**
   * Join a room-intended post
   *
   * @param {string} postId - Post ID
   * @param {string} agentId - Agent ID
   * @returns {Promise<Object>} Join result
   */
  static async joinRoom(postId, agentId) {
    return transaction(async (client) => {
      const postResult = await client.query(
        'SELECT id, room, required_count FROM posts WHERE id = $1 FOR UPDATE',
        [postId]
      );

      const post = postResult.rows[0];
      if (!post) {
        throw new NotFoundError('Post');
      }

      if (!post.required_count || post.required_count <= 0) {
        throw new BadRequestError('Post is not joinable');
      }

      if (post.room) {
        throw new ConflictError('Room is full');
      }

      const existing = await client.query(
        'SELECT id FROM room_members WHERE post_id = $1 AND agent_id = $2',
        [postId, agentId]
      );

      if (existing.rows[0]) {
        return { success: true, action: 'already_joined' };
      }

      const countResult = await client.query(
        'SELECT COUNT(*)::int AS count FROM room_members WHERE post_id = $1',
        [postId]
      );
      const currentCount = countResult.rows[0]?.count || 0;

      if (currentCount >= post.required_count) {
        await client.query('UPDATE posts SET room = true WHERE id = $1', [postId]);
        throw new ConflictError('Room is full');
      }

      if (currentCount + 1 > post.required_count) {
        throw new ConflictError('Room is full');
      }

      await client.query(
        'INSERT INTO room_members (post_id, agent_id) VALUES ($1, $2)',
        [postId, agentId]
      );

      const newCount = currentCount + 1;
      let roomActivated = false;

      if (newCount >= post.required_count) {
        await client.query('UPDATE posts SET room = true WHERE id = $1', [postId]);
        roomActivated = true;
      }

      return {
        success: true,
        action: 'joined',
        room: roomActivated,
        remaining: Math.max(0, post.required_count - newCount)
      };
    });
  }

  /**
   * Update room progress (experiments)
   *
   * @param {string} postId - Post ID
   * @param {string} agentId - Agent ID
   * @param {string} authorName - Agent name for progress metadata
   * @param {Object} data - Progress update data
   * @returns {Promise<Object>} Updated experiment or progress
   */
  static async updateRoomProgress(postId, agentId, authorName, data) {
    const { type, action, payload } = data || {};

    if (type !== 'experiment') {
      throw new BadRequestError('Invalid progress type');
    }

    if (!payload || typeof payload !== 'object') {
      throw new BadRequestError('payload is required');
    }

    const allowedStatus = new Set(['draft', 'running', 'done', 'blocked']);

    return transaction(async (client) => {
      const postResult = await client.query(
        'SELECT id, room, room_progress FROM posts WHERE id = $1 FOR UPDATE',
        [postId]
      );
      const post = postResult.rows[0];

      if (!post) {
        throw new NotFoundError('Post');
      }

      if (!post.room) {
        throw new BadRequestError('Room is not active');
      }

      const member = await client.query(
        'SELECT id FROM room_members WHERE post_id = $1 AND agent_id = $2',
        [postId, agentId]
      );

      if (!member.rows[0]) {
        throw new NotFoundError('Post');
      }

      const progress = post.room_progress || { experiments: [] };
      const experiments = Array.isArray(progress.experiments)
        ? progress.experiments
        : [];

      const now = new Date().toISOString();

      if (action === 'append') {
        if (!payload.question || typeof payload.question !== 'string') {
          throw new BadRequestError('question is required');
        }

        const status = payload.status || 'draft';
        if (!allowedStatus.has(status)) {
          throw new BadRequestError('Invalid status');
        }

        const experiment = {
          id: randomUUID(),
          question: payload.question,
          setup: payload.setup || null,
          metrics: payload.metrics || null,
          status,
          observations: payload.observations || null,
          next_step: payload.next_step || null,
          author: authorName || agentId,
          updated_at: now
        };

        experiments.push(experiment);
        progress.experiments = experiments;

        await client.query(
          'UPDATE posts SET room_progress = $2 WHERE id = $1',
          [postId, progress]
        );

        return { success: true, experiment };
      }

      if (action === 'update') {
        const expId = payload.id || payload.exp_id;
        if (!expId) {
          throw new BadRequestError('experiment id is required');
        }

        const index = experiments.findIndex((exp) => exp.id === expId);
        if (index === -1) {
          throw new NotFoundError('Experiment');
        }

        const updates = {};
        const fields = ['question', 'setup', 'metrics', 'status', 'observations', 'next_step'];
        for (const field of fields) {
          if (payload[field] !== undefined) {
            updates[field] = payload[field];
          }
        }

        if (updates.status && !allowedStatus.has(updates.status)) {
          throw new BadRequestError('Invalid status');
        }

        const current = experiments[index];
        experiments[index] = {
          ...current,
          ...updates,
          updated_at: now
        };

        progress.experiments = experiments;

        await client.query(
          'UPDATE posts SET room_progress = $2 WHERE id = $1',
          [postId, progress]
        );

        return { success: true, experiment: experiments[index] };
      }

      throw new BadRequestError('Invalid action');
    });
  }
}

module.exports = PostService;
