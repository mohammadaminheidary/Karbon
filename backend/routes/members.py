from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Response,
    status,
)

from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from database import get_database

from models.user import User

from schemas.member_schema import (
    MemberCreate,
    MemberResponse,
    MemberUpdate,
)

from security.auth import (
    get_current_user,
)

from services.member_service import (
    create_member,
    delete_member,
    get_member_by_id,
    get_members,
    update_member,
)


router = APIRouter(
    prefix="/api",
    tags=["Members"],
)


def member_not_found():
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail="عضو موردنظر پیدا نشد",
    )


def database_error():
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="خطایی در ذخیره اطلاعات رخ داد",
    )


@router.get(
    "/members",
    response_model=list[MemberResponse],
)
def list_members(
    skip: int = Query(
        default=0,
        ge=0,
    ),
    limit: int = Query(
        default=100,
        ge=1,
        le=500,
    ),
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    return get_members(
        db,
        skip=skip,
        limit=limit,
    )


@router.post(
    "/members",
    response_model=MemberResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_member(
    data: MemberCreate,
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    try:
        return create_member(
            db,
            data,
        )

    except SQLAlchemyError:
        raise database_error()


@router.put(
    "/members/{member_id}",
    response_model=MemberResponse,
)
def edit_member(
    member_id: int,
    data: MemberUpdate,
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    member = get_member_by_id(
        db,
        member_id,
    )


    if member is None:
        raise member_not_found()


    try:
        return update_member(
            db,
            member,
            data,
        )

    except SQLAlchemyError:
        raise database_error()


@router.delete(
    "/members/{member_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
def remove_member(
    member_id: int,
    db: Session = Depends(
        get_database
    ),
    current_user: User = Depends(
        get_current_user
    ),
):
    member = get_member_by_id(
        db,
        member_id,
    )


    if member is None:
        raise member_not_found()


    try:
        delete_member(
            db,
            member,
        )

    except SQLAlchemyError:
        raise database_error()


    return Response(
        status_code=status.HTTP_204_NO_CONTENT
    )