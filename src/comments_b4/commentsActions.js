import { createAction } from 'redux-actions';
import SteemConnect from 'sc2-sdk';
import { createCommentPermlink, getBodyPatchIfSmaller } from '../vendor/steemitHelpers';
import { notify } from '../app/Notification/notificationActions';
import { updateContribution } from '../actions/contribution';

const version = require('../../package.json').version;

export const GET_COMMENTS = 'GET_COMMENTS';
export const GET_COMMENTS_START = 'GET_COMMENTS_START';
export const GET_COMMENTS_SUCCESS = 'GET_COMMENTS_SUCCESS';
export const GET_COMMENTS_ERROR = 'GET_COMMENTS_ERROR';

export const SEND_COMMENT = 'SEND_COMMENT';
export const SEND_COMMENT_START = 'SEND_COMMENT_START';
export const SEND_COMMENT_SUCCESS = 'SEND_COMMENT_SUCCESS';
export const SEND_COMMENT_ERROR = 'SEND_COMMENT_ERROR';

export const LIKE_COMMENT = '@comments/LIKE_COMMENT';
export const LIKE_COMMENT_START = '@comments/LIKE_COMMENT_START';
export const LIKE_COMMENT_SUCCESS = '@comments/LIKE_COMMENT_SUCCESS';
export const LIKE_COMMENT_ERROR = '@comments/LIKE_COMMENT_ERROR';

export const RELOAD_EXISTING_COMMENT = '@comments/RELOAD_EXISTING_COMMENT';
export const reloadExistingComment = createAction(RELOAD_EXISTING_COMMENT,
  undefined,
  data => ({ commentId: data.id }),
);

const getRootCommentsList = apiRes => Object.keys(apiRes.content)
  .filter(commentKey => apiRes.content[commentKey].depth === 1)
  .map(commentKey => apiRes.content[commentKey].id);

const getCommentsChildrenLists = (apiRes) => {
  const listsById = {};
  Object.keys(apiRes.content).forEach((commentKey) => {
    listsById[apiRes.content[commentKey].id] = apiRes.content[commentKey].replies.map(
      childKey => apiRes.content[childKey].id,
    );
  });

  return listsById;
};

/**
 * Fetches comments from blockchain.
 * @param {number} postId Id of post to fetch comments from
 * @param {boolean} reload If set to true isFetching won't be set to true
 * preventing loading icon to be dispalyed
 * @param {object} focusedComment Object with author and permlink to which focus after loading
 */
export const getComments = (postId, reload = false, focusedComment = undefined) =>
  (dispatch, getState, { steemAPI }) => {
    const { contribution } = getState();
    const content = contribution;

    const { category, author, permlink } = content;

    dispatch({
      type: GET_COMMENTS,
      payload: {
        promise: steemAPI.getStateAsync(`/${category}/@${author}/${permlink}`).then(apiRes => ({
          rootCommentsList: getRootCommentsList(apiRes),
          commentsChildrenList: getCommentsChildrenLists(apiRes),
          content: apiRes.content,
        })),
      },
      meta: {
        id: postId,
        reload,
        focusedComment,
      },
    });
  };

export const sendComment = (parentPost, body, isUpdating = false, originalComment) =>
  (dispatch, getState) => {
    const {
      category,
      root_comment: rootComment,
      permlink: parentPermlink,
      author: parentAuthor,
    } = parentPost;
    const { auth, contribution } = getState();

    if (!auth.isAuthenticated) {
      return dispatch(notify('You have to be logged in to comment', 'error'));
    }

    if (!body || !body.length) {
      return dispatch(notify("Message can't be empty", 'error'));
    }

    const author = auth.user.name;
    const permlink = isUpdating
      ? originalComment.permlink
      : createCommentPermlink(parentAuthor, parentPermlink);
    const jsonMetadata = { tags: [category], community: 'utopian', app: `utopian/${version}` };

    const newBody = isUpdating ? getBodyPatchIfSmaller(originalComment.body, body) : body;

    return dispatch({
      type: SEND_COMMENT,
      payload: {
        promise: SteemConnect.comment(
          parentAuthor,
          parentPermlink,
          author,
          permlink,
          '',
          newBody,
          jsonMetadata,
        )
          .then((resp) => {
            const focusedComment = {
              author: resp.result.operations[0][1].author,
              permlink: resp.result.operations[0][1].permlink,
            };
            dispatch(notify('Comment submitted successfully', 'success'));
            dispatch(updateContribution(contribution.author, contribution.permlink));
            dispatch(getComments(rootComment, true, focusedComment));

            if (window.ga) {
              window.ga('send', 'event', 'comment', 'submit', '', 5);
            }
          }),
      },
      meta: {
        parentId: parentPost.id,
        isEditing: false,
        isReplyToComment: parentPost.id !== rootComment,
      },
    });
  };

export const likeComment = (commentId, weight = 10000, vote = 'like', retryCount = 0) =>
  (dispatch, getState, { steemAPI }) => {
    const { auth, comments } = getState();

    if (!auth.isAuthenticated) {
      return;
    }

    const voter = auth.user.name;
    const { author, permlink } = comments.comments[commentId];

    dispatch({
      type: LIKE_COMMENT,
      payload: {
        promise: SteemConnect.vote(voter, author, permlink, weight).then((res) => {
          // reload comment data to fetch payout after vote
          steemAPI.getContentAsync(author, permlink).then((data) => {
            dispatch(reloadExistingComment(data));
            return data;
          });
          return res;
        }),
      },
      meta: { commentId, voter, weight, vote, isRetry: retryCount > 0 },
    }).catch((err) => {
      if (err.res && err.res.status === 500 && retryCount <= 5) {
        dispatch(likeComment(commentId, weight, vote, retryCount + 1));
      }
    });
  };