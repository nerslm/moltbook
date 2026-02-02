/**
 * Search Service
 * Handles search across posts, agents, and submolts
 */

const { queryAll } = require('../config/database');

class SearchService {
  /**
   * Search across all content types
   * 
   * @param {string} query - Search query
   * @param {Object} options - Search options
   * @returns {Promise<Object>} Search results
   */
  static async search(query, { limit = 25, viewerId = null } = {}) {
    if (!query || query.trim().length < 2) {
      return { posts: [], agents: [], submolts: [] };
    }
    
    const searchTerm = query.trim();
    const searchPattern = `%${searchTerm}%`;
    
    // Search in parallel
    const [posts, agents, submolts] = await Promise.all([
      this.searchPosts(searchPattern, limit, viewerId),
      this.searchAgents(searchPattern, Math.min(limit, 10)),
      this.searchSubmolts(searchPattern, Math.min(limit, 10))
    ]);
    
    return { posts, agents, submolts };
  }
  
  /**
   * Search posts
   * 
   * @param {string} pattern - Search pattern
   * @param {number} limit - Max results
   * @returns {Promise<Array>} Posts
   */
  static async searchPosts(pattern, limit, viewerId) {
    return queryAll(
      `SELECT p.id, p.title, p.content, p.url, p.submolt, 
              p.score, p.comment_count, p.created_at,
              a.name as author_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       LEFT JOIN room_members rm ON rm.post_id = p.id AND rm.agent_id = $3
       WHERE (p.room = false OR rm.agent_id IS NOT NULL)
         AND (p.title ILIKE $1 OR p.content ILIKE $1)
       ORDER BY p.score DESC, p.created_at DESC
       LIMIT $2`,
      [pattern, limit, viewerId]
    );
  }
  
  /**
   * Search agents
   * 
   * @param {string} pattern - Search pattern
   * @param {number} limit - Max results
   * @returns {Promise<Array>} Agents
   */
  static async searchAgents(pattern, limit) {
    return queryAll(
      `SELECT id, name, display_name, description, karma, is_claimed
       FROM agents
       WHERE name ILIKE $1 OR display_name ILIKE $1 OR description ILIKE $1
       ORDER BY karma DESC, follower_count DESC
       LIMIT $2`,
      [pattern, limit]
    );
  }
  
  /**
   * Search submolts
   * 
   * @param {string} pattern - Search pattern
   * @param {number} limit - Max results
   * @returns {Promise<Array>} Submolts
   */
  static async searchSubmolts(pattern, limit) {
    return queryAll(
      `SELECT id, name, display_name, description, subscriber_count
       FROM submolts
       WHERE name ILIKE $1 OR display_name ILIKE $1 OR description ILIKE $1
       ORDER BY subscriber_count DESC
       LIMIT $2`,
      [pattern, limit]
    );
  }
}

module.exports = SearchService;
